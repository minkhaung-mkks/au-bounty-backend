import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { validate } from '../middleware/validate.js'
import { requireUser } from '../middleware/auth.js'
import { conflict, notFound, unauthorized } from '../lib/errors.js'
import { serializeTask, taskInclude, userCard } from '../lib/serialize.js'

export const usersRouter = Router()

const idParam = z.object({ id: z.uuid() })

async function statsFor(userId) {
  const [completed, events, agg] = await Promise.all([
    prisma.taskAssignment.count({
      where: { takerId: userId, status: 'COMPLETED', task: { type: { not: 'EVENT' } } },
    }),
    prisma.taskAssignment.count({
      where: { takerId: userId, task: { type: 'EVENT' }, status: { in: ['ACCEPTED', 'COMPLETED'] } },
    }),
    prisma.review.aggregate({
      where: { revieweeId: userId, published: true },
      _avg: { rating: true },
      _count: true,
    }),
  ])
  return {
    completed,
    events,
    reviewCount: agg._count,
    rating: agg._avg.rating ? Number(agg._avg.rating.toFixed(2)) : null,
  }
}

/* ------------------------------------------------------------------- me */

usersRouter.get('/me', requireUser, async (req, res) => {
  // The session carries only { id, role, name, orgIds }; the profile needs the
  // fresh row anyway so bio/universityId edits show without a re-login.
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { memberships: { include: { org: true } } },
  })
  if (!user) throw unauthorized('Session points at a deleted user.')

  const [tags, stats] = await Promise.all([
    prisma.userTag.findMany({ where: { userId: user.id }, include: { tag: true } }),
    statsFor(user.id),
  ])
  res.json({
    user: {
      ...userCard(user),
      email: user.email,
      bio: user.bio,
      createdAt: user.createdAt,
    },
    orgs: user.memberships.map((m) => ({ ...m.org, position: m.position })),
    tags: tags.map((t) => t.tag),
    stats,
  })
})

/**
 * Self-service profile edits. universityId is identity: settable exactly once,
 * and afterwards immutable even by resubmitting the same value differently.
 */
usersRouter.put(
  '/me',
  requireUser,
  validate({
    body: z.object({
      bio: z.string().max(1000, 'Bio tops out at 1000 characters.').nullable().optional(),
      universityId: z.string().trim().min(3, 'Too short for a student id.').max(32).optional(),
    }),
  }),
  async (req, res) => {
    const { bio, universityId } = req.valid.body
    const user = await prisma.user.findUnique({ where: { id: req.user.id } })
    if (!user) throw unauthorized('Session points at a deleted user.')

    if (universityId !== undefined && user.universityId !== null && user.universityId !== universityId) {
      throw conflict('universityId is already set and cannot be changed.')
    }

    let updated
    try {
      updated = await prisma.user.update({
        where: { id: user.id },
        data: { bio, universityId },
      })
    } catch (err) {
      if (err?.code === 'P2002') throw conflict('That universityId belongs to someone else.')
      throw err
    }

    res.json({
      user: { ...userCard(updated), email: updated.email, bio: updated.bio, createdAt: updated.createdAt },
    })
  },
)

usersRouter.put(
  '/me/tags',
  requireUser,
  validate({ body: z.object({ tagIds: z.array(z.uuid()).max(8) }) }),
  async (req, res) => {
    const { tagIds } = req.valid.body
    await prisma.userTag.deleteMany({ where: { userId: req.user.id } })
    if (tagIds.length) {
      await prisma.userTag.createMany({
        data: tagIds.map((tagId) => ({ userId: req.user.id, tagId })),
      })
    }
    const tags = await prisma.userTag.findMany({
      where: { userId: req.user.id },
      include: { tag: true },
    })
    res.json({ tags: tags.map((t) => t.tag) })
  },
)

/* --------------------------------------------------------------- my work */

usersRouter.get('/me/tasks', requireUser, async (req, res) => {
  const me = req.user

  const posted = await prisma.task.findMany({
    where: { posterId: me.id },
    include: taskInclude,
    orderBy: { createdAt: 'desc' },
  })

  const assignments = await prisma.taskAssignment.findMany({
    where: { takerId: me.id, status: { notIn: ['WITHDRAWN', 'REJECTED'] } },
    include: { task: { include: taskInclude } },
    orderBy: { appliedAt: 'desc' },
  })

  const taking = assignments.filter((a) => a.task.type !== 'EVENT')
  const events = assignments.filter((a) => a.task.type === 'EVENT')

  res.json({
    posted: posted.map((t) => serializeTask(t, me, { withApplicants: true })),
    taking: taking.map((a) => ({
      assignment: {
        id: a.id,
        status: a.status,
        completionRequestedAt: a.completionRequestedAt,
        completedAt: a.completedAt,
      },
      task: serializeTask(a.task, me),
    })),
    events: events.map((a) => ({
      assignment: { id: a.id, status: a.status, checkedInAt: a.checkedInAt },
      task: serializeTask(a.task, me),
    })),
    needsReview: await pendingReviews(me.id),
  })
})

/**
 * Everyone the current user finished a task with and has not reviewed yet.
 * Events are excluded because they do not take reviews.
 */
async function pendingReviews(userId) {
  const completed = await prisma.taskAssignment.findMany({
    where: {
      status: 'COMPLETED',
      task: { type: { not: 'EVENT' } },
      OR: [{ takerId: userId }, { task: { posterId: userId } }],
    },
    include: {
      taker: { select: { id: true, name: true, role: true, universityId: true } },
      task: { include: { poster: { select: { id: true, name: true, role: true, universityId: true } } } },
    },
  })

  const written = await prisma.review.findMany({
    where: { reviewerId: userId },
    select: { taskId: true, revieweeId: true },
  })
  const done = new Set(written.map((r) => `${r.taskId}:${r.revieweeId}`))

  return completed
    .map((a) => {
      const counterpart = a.takerId === userId ? a.task.poster : a.taker
      return {
        assignmentId: a.id,
        taskId: a.taskId,
        taskTitle: a.task.title,
        completedAt: a.completedAt,
        counterpart: userCard(counterpart),
      }
    })
    .filter((r) => r.counterpart.id !== userId && !done.has(`${r.taskId}:${r.counterpart.id}`))
}

/* -------------------------------------------------- public profile (open) */

// No user header required: the proposal promises a profile link a recruiter can
// open without logging in.
usersRouter.get('/users/:id', validate({ params: idParam }), async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.valid.params.id },
    include: { tags: { include: { tag: true } }, memberships: { include: { org: true } } },
  })
  if (!user) throw notFound('No user with that id.')

  const [stats, reviews] = await Promise.all([
    statsFor(user.id),
    prisma.review.findMany({
      where: { revieweeId: user.id, published: true },
      include: {
        reviewer: { select: { id: true, name: true } },
        task: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  res.json({
    user: {
      ...userCard(user),
      bio: user.bio,
      createdAt: user.createdAt,
      orgs: user.memberships.map((m) => ({ ...m.org, position: m.position })),
      tags: user.tags.map((t) => t.tag),
    },
    stats,
    // Every review shows, good and bad. An admin can strip abusive wording, but
    // the rating stays counted, so moderation can never inflate a score.
    reviews: reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      text: r.textHidden ? null : r.text,
      textHidden: r.textHidden,
      createdAt: r.createdAt,
      reviewer: r.reviewer,
      task: r.task,
    })),
  })
})
