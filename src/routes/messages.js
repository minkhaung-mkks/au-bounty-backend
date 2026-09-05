import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { validate } from '../middleware/validate.js'
import { requireUser } from '../middleware/auth.js'
import { badRequest, forbidden, notFound } from '../lib/errors.js'
import { serializeMessage } from '../lib/serialize.js'
import { emitMessageNew, emitMessageRead } from '../realtime/emit.js'

/**
 * D3 messaging. All writes are REST; sockets only fan the result out to the
 * thread room and the counterpart's personal room.
 */
export const messagesRouter = Router()

const idParam = z.object({ id: z.uuid() })

const listQuery = z.object({
  // Cursor pagination: `before` is a message id from an already-loaded page.
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const postBody = z.object({
  content: z.string().trim().min(1, 'A message cannot be empty.').max(4000),
})

/** Loads a thread and enforces that the caller is one of its two participants. */
async function loadThread(id, user) {
  const assignment = await prisma.taskAssignment.findUnique({
    where: { id },
    select: { id: true, takerId: true, task: { select: { posterId: true } } },
  })
  if (!assignment) throw notFound('No assignment with that id.')
  const isParticipant = assignment.takerId === user.id || assignment.task.posterId === user.id
  if (!isParticipant) throw forbidden('Only the two participants can open this thread.')
  return assignment
}

/** The user on the other side of the thread from `user`. */
function counterpartIdOf(assignment, user) {
  return assignment.takerId === user.id ? assignment.task.posterId : assignment.takerId
}

/* ------------------------------------------------------------------ threads */

// The inbox: every live assignment the caller participates in, newest activity
// first, with the other party, the last message and the unread badge count.
messagesRouter.get('/me/threads', requireUser, async (req, res) => {
  const me = req.user
  const assignments = await prisma.taskAssignment.findMany({
    where: {
      status: { notIn: ['WITHDRAWN', 'REJECTED'] },
      OR: [{ takerId: me.id }, { task: { posterId: me.id } }],
    },
    include: {
      task: { select: { id: true, title: true, type: true, posterId: true, poster: { select: { id: true, name: true } } } },
      taker: { select: { id: true, name: true } },
      messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
    },
  })
  if (!assignments.length) return res.json({ threads: [] })

  const unread = await prisma.message.groupBy({
    by: ['assignmentId'],
    where: {
      assignmentId: { in: assignments.map((a) => a.id) },
      senderId: { not: me.id },
      readAt: null,
    },
    _count: { _all: true },
  })
  const unreadByAssignment = new Map(unread.map((u) => [u.assignmentId, u._count._all]))

  const threads = assignments
    .map((a) => {
      const last = a.messages[0] ?? null
      const counterpart = a.takerId === me.id ? a.task.poster : a.taker
      return {
        assignmentId: a.id,
        taskId: a.task.id,
        taskTitle: a.task.title,
        taskType: a.task.type,
        counterpart,
        lastMessage: last
          ? { content: last.content, createdAt: last.createdAt, senderId: last.senderId }
          : null,
        unreadCount: unreadByAssignment.get(a.id) ?? 0,
        lastActivityAt: last ? last.createdAt : a.appliedAt,
      }
    })
    // Last activity desc: the newest message wins, else when the thread started.
    .sort((x, y) => y.lastActivityAt.getTime() - x.lastActivityAt.getTime())

  res.json({ threads })
})

/* ------------------------------------------------------------------ history */

messagesRouter.get(
  '/assignments/:id/messages',
  requireUser,
  validate({ params: idParam, query: listQuery }),
  async (req, res) => {
    const { id } = req.valid.params
    const { before, limit } = req.valid.query
    await loadThread(id, req.user)

    const where = { assignmentId: id }
    if (before) {
      const anchor = await prisma.message.findUnique({ where: { id: before } })
      if (!anchor || anchor.assignmentId !== id) throw badRequest('Unknown `before` cursor.')
      // Same-millisecond messages break a pure timestamp cursor; id breaks the tie.
      where.OR = [
        { createdAt: { lt: anchor.createdAt } },
        { createdAt: anchor.createdAt, id: { lt: anchor.id } },
      ]
    }

    // Newest page first, then flipped to ascending for the client.
    const page = await prisma.message.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    })
    const hasMore = page.length > limit
    const messages = page.slice(0, limit).reverse()

    res.json({ messages: messages.map(serializeMessage), hasMore })
  },
)

/* -------------------------------------------------------------------- write */

messagesRouter.post(
  '/assignments/:id/messages',
  requireUser,
  validate({ params: idParam, body: postBody }),
  async (req, res) => {
    const { id } = req.valid.params
    const thread = await loadThread(id, req.user)

    const message = await prisma.message.create({
      data: { assignmentId: id, senderId: req.user.id, content: req.valid.body.content },
    })

    emitMessageNew(serializeMessage(message), counterpartIdOf(thread, req.user))
    res.status(201).json({ message: serializeMessage(message) })
  },
)

/* -------------------------------------------------------------- read marker */

messagesRouter.post(
  '/assignments/:id/read',
  requireUser,
  validate({ params: idParam }),
  async (req, res) => {
    const { id } = req.valid.params
    await loadThread(id, req.user)

    // Only the counterpart's unread messages move; the reader's own never do.
    const pending = { assignmentId: id, senderId: { not: req.user.id }, readAt: null }
    const newest = await prisma.message.findFirst({
      where: pending,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    })
    if (newest) {
      await prisma.message.updateMany({ where: pending, data: { readAt: new Date() } })
      emitMessageRead({ assignmentId: id, readerId: req.user.id, untilMessageId: newest.id })
    }

    res.status(204).end()
  },
)
