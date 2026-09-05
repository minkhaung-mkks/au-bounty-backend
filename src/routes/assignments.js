import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { validate } from '../middleware/validate.js'
import { requireUser } from '../middleware/auth.js'
import { ownsTask } from '../middleware/authorize.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js'
import { HOLDS_A_SPOT } from '../services/settle.js'
import { notifyCompletionRequested } from '../services/mailScheduler.js'
import { emitTaskUpdated } from '../realtime/emit.js'

export const assignmentsRouter = Router()

const idParam = z.object({ id: z.uuid() })

async function load(id) {
  const assignment = await prisma.taskAssignment.findUnique({
    where: { id },
    include: { task: { include: { assignments: true, poster: true } }, taker: true },
  })
  if (!assignment) throw notFound('No assignment with that id.')
  return assignment
}

const step = (path, handler) =>
  assignmentsRouter.post(path, requireUser, validate({ params: idParam }), async (req, res) => {
    const assignment = await load(req.valid.params.id)
    const updated = await handler(assignment, req.user)
    // Every transition here moves occupancy or status, so the task detail room
    // hears about it from one place instead of five handlers.
    await emitTaskUpdated(assignment.taskId)
    res.json({ assignment: updated })
  })

/* The poster picks who gets in, on apply-and-approve tasks. */
step('/assignments/:id/accept', async (a, user) => {
  if (!ownsTask(user, a.task)) throw forbidden('Only the poster decides who is accepted.')
  if (a.status !== 'APPLIED') throw conflict(`Cannot accept an assignment that is ${a.status}.`)

  // Occupancy check and accept run as one transaction on the locked task row,
  // so a racing AUTO apply (or a second organizer clicking) cannot slip past
  // maxTakers between the count and the write.
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${a.taskId} FOR UPDATE`
    const taken = await tx.taskAssignment.count({
      where: { taskId: a.taskId, status: { in: HOLDS_A_SPOT } },
    })
    if (taken >= a.task.maxTakers) throw conflict('Every spot is already filled.')
    return tx.taskAssignment.update({ where: { id: a.id }, data: { status: 'ACCEPTED' } })
  })
})

step('/assignments/:id/reject', async (a, user) => {
  if (!ownsTask(user, a.task)) throw forbidden('Only the poster decides who is accepted.')
  if (a.status !== 'APPLIED') throw conflict(`Cannot decline an assignment that is ${a.status}.`)
  return prisma.taskAssignment.update({ where: { id: a.id }, data: { status: 'REJECTED' } })
})

/* The taker says the work is done. The poster now has 7 days to disagree. */
step('/assignments/:id/complete', async (a, user) => {
  if (a.takerId !== user.id) throw forbidden('Only the taker marks their own work done.')
  if (a.task.type === 'EVENT') {
    throw badRequest('Events complete through attendance check-in, not by marking work done.')
  }
  if (!['ACCEPTED', 'IN_PROGRESS'].includes(a.status)) {
    throw conflict(`Cannot mark work done from ${a.status}.`)
  }
  const updated = await prisma.taskAssignment.update({
    where: { id: a.id },
    data: { status: 'PENDING_CONFIRMATION', completionRequestedAt: new Date() },
  })
  // D8: one reminder to the poster, deduped by the outbox. A mail failure must
  // never fail the completion request itself.
  await notifyCompletionRequested({ ...updated, task: a.task, taker: a.taker }).catch((err) =>
    console.warn(`completion email for assignment ${a.id} failed: ${err.message}`),
  )
  return updated
})

/* The poster confirms. If they never do, settle() confirms it after 7 days. */
step('/assignments/:id/confirm', async (a, user) => {
  if (!ownsTask(user, a.task)) throw forbidden('Only the poster confirms completion.')
  if (a.status !== 'PENDING_CONFIRMATION') {
    throw conflict(`Cannot confirm an assignment that is ${a.status}.`)
  }
  return prisma.taskAssignment.update({
    where: { id: a.id },
    data: { status: 'COMPLETED', completedAt: new Date() },
  })
})

step('/assignments/:id/withdraw', async (a, user) => {
  if (a.takerId !== user.id) throw forbidden('You can only withdraw your own application.')
  if (!['APPLIED', 'ACCEPTED', 'IN_PROGRESS'].includes(a.status)) {
    throw conflict(`Cannot withdraw from ${a.status}.`)
  }
  return prisma.taskAssignment.update({ where: { id: a.id }, data: { status: 'WITHDRAWN' } })
})
