import { prisma } from '../lib/prisma.js'
import { HOLDS_A_SPOT } from '../lib/occupancy.js'
import { emitTaskUpdated } from '../realtime/emit.js'

export const AUTO_CONFIRM_DAYS = 7
export const REVIEW_PUBLISH_AFTER_BOTH_DAYS = 1
export const REVIEW_PUBLISH_AFTER_ONE_DAYS = 7

// Re-exported for the routes that already imported it from here.
export { HOLDS_A_SPOT }

const days = (n) => n * 24 * 60 * 60 * 1000
const ago = (n) => new Date(Date.now() - days(n))

/**
 * The two time-based rules from the proposal, evaluated on read instead of by a
 * background job. Nothing here depends on the API process having been alive when
 * the deadline passed, so a restart cannot lose a transition.
 *
 * Returns the ids of every task whose status or occupancy changed, so the caller
 * can fan task:updated out to the detail rooms. Called once per request by
 * settleMiddleware.
 */
export async function settle() {
  const touched = new Set()
  await autoConfirmCompletions(touched)
  await lockFullOrExpiredTasks(touched)
  await completeFinishedTasks(touched)
  await publishDueReviews()
  return [...touched]
}

/** A poster who never responds cannot hold a helper's record hostage. */
async function autoConfirmCompletions(touched) {
  const due = await prisma.taskAssignment.findMany({
    where: {
      status: 'PENDING_CONFIRMATION',
      completionRequestedAt: { lte: ago(AUTO_CONFIRM_DAYS) },
    },
    select: { id: true, taskId: true, completionRequestedAt: true },
  })
  for (const a of due) {
    await prisma.taskAssignment.update({
      where: { id: a.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(a.completionRequestedAt.getTime() + days(AUTO_CONFIRM_DAYS)),
      },
    })
    touched.add(a.taskId)
  }
}

/** OPEN means takeable. A task past its deadline or out of spots is LOCKED. */
async function lockFullOrExpiredTasks(touched) {
  const expired = await prisma.task.findMany({
    where: { status: 'OPEN', deadline: { lt: new Date() } },
    select: { id: true },
  })
  if (expired.length) {
    await prisma.task.updateMany({
      where: { id: { in: expired.map((t) => t.id) } },
      data: { status: 'LOCKED' },
    })
    expired.forEach((t) => touched.add(t.id))
  }

  const open = await prisma.task.findMany({
    where: { status: 'OPEN' },
    select: {
      id: true,
      maxTakers: true,
      assignments: { where: { status: { in: HOLDS_A_SPOT } }, select: { id: true } },
    },
  })
  const full = open.filter((t) => t.assignments.length >= t.maxTakers).map((t) => t.id)
  if (full.length) {
    await prisma.task.updateMany({ where: { id: { in: full } }, data: { status: 'LOCKED' } })
    full.forEach((id) => touched.add(id))
  }
}

/** Every spot filled and every taker finished means the posting itself is done. */
async function completeFinishedTasks(touched) {
  const locked = await prisma.task.findMany({
    where: { status: 'LOCKED' },
    select: {
      id: true,
      maxTakers: true,
      assignments: { where: { status: { in: HOLDS_A_SPOT } }, select: { status: true } },
    },
  })
  const done = locked
    .filter(
      (t) =>
        t.assignments.length >= t.maxTakers &&
        t.assignments.every((a) => a.status === 'COMPLETED'),
    )
    .map((t) => t.id)
  if (done.length) {
    await prisma.task.updateMany({ where: { id: { in: done } }, data: { status: 'COMPLETED' } })
    done.forEach((id) => touched.add(id))
  }
}

/**
 * Double-blind gate. A review publishes 1 day after both sides of the pair have
 * submitted, or 7 days after only one side has. Until then nobody sees a rating
 * they could retaliate against.
 */
async function publishDueReviews() {
  const pending = await prisma.review.findMany({
    where: { published: false },
    select: { id: true, taskId: true, reviewerId: true, revieweeId: true, createdAt: true },
  })
  if (!pending.length) return

  const pairs = new Map()
  for (const r of pending) {
    const key = `${r.taskId}:${[r.reviewerId, r.revieweeId].sort().join('|')}`
    if (!pairs.has(key)) pairs.set(key, [])
    pairs.get(key).push(r)
  }

  const now = Date.now()
  const toPublish = []
  for (const reviews of pairs.values()) {
    if (reviews.length >= 2) {
      const latest = Math.max(...reviews.map((r) => r.createdAt.getTime()))
      if (now >= latest + days(REVIEW_PUBLISH_AFTER_BOTH_DAYS)) {
        toPublish.push(...reviews.map((r) => r.id))
      }
    } else {
      const only = reviews[0]
      if (now >= only.createdAt.getTime() + days(REVIEW_PUBLISH_AFTER_ONE_DAYS)) {
        toPublish.push(only.id)
      }
    }
  }

  if (toPublish.length) {
    await prisma.review.updateMany({ where: { id: { in: toPublish } }, data: { published: true } })
  }
}

export async function settleMiddleware(req, res, next) {
  try {
    const touched = await settle()
    for (const taskId of touched) await emitTaskUpdated(taskId)
  } catch (err) {
    // A settle failure must not take down a read. Log it and serve what we have.
    console.error('settle failed:', err)
  }
  next()
}
