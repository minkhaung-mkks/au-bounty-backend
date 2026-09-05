import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { validate } from '../middleware/validate.js'
import { requireUser } from '../middleware/auth.js'
import { canManageCheckin, canOfferExtraCredit, canPostEvent, ownsTask } from '../middleware/authorize.js'
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js'
import { serializeTask, taskInclude } from '../lib/serialize.js'
import { HOLDS_A_SPOT, settle } from '../services/settle.js'
import { emitTaskCreated, emitTaskUpdated } from '../realtime/emit.js'
import { STEP_SECONDS, currentCode, remainingSeconds, verify } from '../lib/totp.js'
import { icsForTask } from '../lib/ics.js'

export const tasksRouter = Router()

const TASK_TYPES = ['REQUEST', 'EVENT', 'EMERGENCY']
const REWARD_TYPES = ['NONE', 'CASH', 'EXTRA_CREDIT', 'OTHER']

const listQuery = z.object({
  type: z.enum(TASK_TYPES).optional(),
  q: z.string().trim().max(120).optional(),
  matches: z.enum(['true', 'false']).optional(),
  status: z.enum(['OPEN', 'LOCKED', 'COMPLETED', 'CANCELLED', 'ALL']).default('OPEN'),
  mine: z.enum(['true', 'false']).optional(),
})

const createBody = z.object({
  title: z.string().trim().min(3).max(120),
  content: z.string().trim().min(1).max(4000),
  type: z.enum(TASK_TYPES),
  rewardType: z.enum(REWARD_TYPES).default('NONE'),
  rewardDescription: z.string().trim().max(200).default(''),
  maxTakers: z.number().int().min(1).max(1000).default(1),
  acceptanceMode: z.enum(['AUTO', 'APPROVAL']).default('APPROVAL'),
  locationName: z.string().trim().min(1).max(160),
  locationLat: z.number().min(-90).max(90).optional(),
  locationLng: z.number().min(-180).max(180).optional(),
  startsAt: z.coerce.date().optional(),
  deadline: z.coerce.date().optional(),
  orgId: z.uuid().optional(),
  tagIds: z.array(z.uuid()).min(1, 'Pick at least one tag.').max(3, 'Three tags maximum.'),
})

const patchBody = createBody.partial().omit({ type: true })

const checkinBody = z.object({ code: z.string().trim().min(1).max(32) })

const idParam = z.object({ id: z.uuid() })

/* ------------------------------------------------------------------ board */

tasksRouter.get('/tasks', validate({ query: listQuery }), async (req, res) => {
  const { type, q, matches, status, mine } = req.valid.query
  const viewer = req.user

  const where = {}
  if (status !== 'ALL') where.status = status
  if (type) where.type = type
  if (mine === 'true') {
    if (!viewer) return res.json({ tasks: [] })
    where.posterId = viewer.id
  }
  if (q) {
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { content: { contains: q, mode: 'insensitive' } },
      { locationName: { contains: q, mode: 'insensitive' } },
      { tags: { some: { tag: { name: { contains: q, mode: 'insensitive' } } } } },
    ]
  }

  // "Matches" ranks by how many of the task's tags the viewer also has on their
  // profile. Prisma cannot order by a filtered relation count, so the ranking is
  // one raw query that returns ids and scores; the rows themselves come back
  // through the normal include so the response shape stays identical.
  if (matches === 'true') {
    if (!viewer) return res.json({ tasks: [], ranked: true })
    const ranked = await rankByTagOverlap(viewer.id, { type, q, status })
    if (!ranked.length) return res.json({ tasks: [], ranked: true })

    const rows = await prisma.task.findMany({
      where: { id: { in: ranked.map((r) => r.id) } },
      include: taskInclude,
    })
    const order = new Map(ranked.map((r, i) => [r.id, i]))
    rows.sort((a, b) => order.get(a.id) - order.get(b.id))
    return res.json({
      tasks: rows.map((t) => ({
        ...serializeTask(t, viewer),
        matchScore: ranked.find((r) => r.id === t.id).score,
      })),
      ranked: true,
    })
  }

  const tasks = await prisma.task.findMany({
    where,
    include: taskInclude,
    orderBy: { createdAt: 'desc' },
  })
  res.json({ tasks: tasks.map((t) => serializeTask(t, viewer)), ranked: false })
})

async function rankByTagOverlap(userId, { type, q, status }) {
  const filters = [Prisma.sql`TRUE`]
  if (status !== 'ALL') filters.push(Prisma.sql`t."status" = ${status}::"TaskStatus"`)
  if (type) filters.push(Prisma.sql`t."type" = ${type}::"TaskType"`)
  if (q) {
    const like = `%${q}%`
    filters.push(Prisma.sql`(
      t."title" ILIKE ${like}
      OR t."content" ILIKE ${like}
      OR t."locationName" ILIKE ${like}
      OR EXISTS (
        SELECT 1 FROM "TaskTag" x
        JOIN "Tag" g ON g."id" = x."tagId"
        WHERE x."taskId" = t."id" AND g."name" ILIKE ${like}
      )
    )`)
  }

  return prisma.$queryRaw`
    SELECT t."id", COUNT(ut."tagId")::int AS score
    FROM "Task" t
    JOIN "TaskTag" tt ON tt."taskId" = t."id"
    JOIN "UserTag" ut ON ut."tagId" = tt."tagId" AND ut."userId" = ${userId}::uuid
    WHERE ${Prisma.join(filters, ' AND ')}
    GROUP BY t."id", t."createdAt"
    ORDER BY score DESC, t."createdAt" DESC
  `
}

/* ----------------------------------------------------------------- detail */

tasksRouter.get('/tasks/:id', validate({ params: idParam }), async (req, res) => {
  const task = await prisma.task.findUnique({
    where: { id: req.valid.params.id },
    include: taskInclude,
  })
  if (!task) throw notFound('No task with that id.')

  // Applicants are the poster's (or an admin's) business. On events, whoever
  // may validate attendance (the sponsoring org) also needs the roster with
  // its check-in stamps.
  const showApplicants =
    Boolean(req.user) &&
    (ownsTask(req.user, task) || (task.type === 'EVENT' && canManageCheckin(req.user, task)))
  res.json({ task: serializeTask(task, req.user, { withApplicants: showApplicants }) })
})

/* ----------------------------------------------------------------- create */

tasksRouter.post('/tasks', requireUser, validate({ body: createBody }), async (req, res) => {
  const body = req.valid.body
  const user = req.user

  if (body.type === 'EVENT' && !canPostEvent(user)) {
    throw forbidden('Only org members, teachers and admins can post events.')
  }
  if (body.rewardType === 'EXTRA_CREDIT' && !canOfferExtraCredit(user)) {
    throw forbidden('Extra-credit rewards are teacher-only.')
  }
  if (body.rewardType !== 'NONE' && !body.rewardDescription) {
    throw badRequest('Describe the reward, or set the reward type to NONE.')
  }
  if (body.orgId && !user.orgIds.includes(body.orgId) && user.role !== 'ADMIN') {
    throw forbidden('You can only post on behalf of an organization you belong to.')
  }
  // An org member's authority to run an event comes from the membership record,
  // so the event has to name which org it is for.
  if (body.type === 'EVENT' && !body.orgId && user.role === 'STUDENT') {
    if (user.orgIds.length !== 1) throw badRequest('Pick which organization this event is for.')
    body.orgId = user.orgIds[0]
  }

  const tags = await prisma.tag.findMany({ where: { id: { in: body.tagIds } } })
  if (tags.length !== body.tagIds.length) throw badRequest('One of those tags does not exist.')

  const task = await prisma.task.create({
    data: {
      title: body.title,
      content: body.content,
      type: body.type,
      posterId: user.id,
      orgId: body.orgId ?? null,
      rewardType: body.rewardType,
      rewardDescription: body.rewardDescription,
      maxTakers: body.maxTakers,
      acceptanceMode: body.acceptanceMode,
      locationName: body.locationName,
      locationLat: body.locationLat ?? null,
      locationLng: body.locationLng ?? null,
      startsAt: body.startsAt ?? null,
      deadline: body.deadline ?? null,
      // Events verify attendance with a code derived from this secret.
      checkinSecret: body.type === 'EVENT' ? randomBytes(20).toString('hex') : null,
      tags: { create: body.tagIds.map((tagId) => ({ tagId })) },
    },
    include: taskInclude,
  })

  emitTaskCreated(task)
  res.status(201).json({ task: serializeTask(task, user, { withApplicants: true }) })
})

/* ------------------------------------------------------------ edit/cancel */

tasksRouter.patch(
  '/tasks/:id',
  requireUser,
  validate({ params: idParam, body: patchBody }),
  async (req, res) => {
    const task = await prisma.task.findUnique({ where: { id: req.valid.params.id } })
    if (!task) throw notFound('No task with that id.')
    if (!ownsTask(req.user, task)) throw forbidden('You can only edit your own posts.')
    if (task.status === 'COMPLETED') throw conflict('A completed task cannot be edited.')

    const body = req.valid.body
    if (body.rewardType === 'EXTRA_CREDIT' && !canOfferExtraCredit(req.user)) {
      throw forbidden('Extra-credit rewards are teacher-only.')
    }

    const { tagIds, ...scalars } = body
    if (tagIds) {
      await prisma.taskTag.deleteMany({ where: { taskId: task.id } })
      await prisma.taskTag.createMany({ data: tagIds.map((tagId) => ({ taskId: task.id, tagId })) })
    }

    const updated = await prisma.task.update({
      where: { id: task.id },
      data: scalars,
      include: taskInclude,
    })
    await emitTaskUpdated(updated.id)
    res.json({ task: serializeTask(updated, req.user, { withApplicants: true }) })
  },
)

tasksRouter.post('/tasks/:id/cancel', requireUser, validate({ params: idParam }), async (req, res) => {
  const task = await prisma.task.findUnique({ where: { id: req.valid.params.id } })
  if (!task) throw notFound('No task with that id.')
  if (!ownsTask(req.user, task)) throw forbidden('You can only cancel your own posts.')
  if (task.status === 'COMPLETED') throw conflict('A completed task cannot be cancelled.')

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { status: 'CANCELLED' },
    include: taskInclude,
  })
  await emitTaskUpdated(updated.id)
  res.json({ task: serializeTask(updated, req.user, { withApplicants: true }) })
})

/* ------------------------------------------------------------------ apply */

// One endpoint for both "apply to help" and "reserve a seat". An event is just a
// task whose acceptance mode is AUTO.
tasksRouter.post('/tasks/:id/apply', requireUser, validate({ params: idParam }), async (req, res) => {
  const task = await prisma.task.findUnique({
    where: { id: req.valid.params.id },
    include: { assignments: true },
  })
  if (!task) throw notFound('No task with that id.')
  if (task.posterId === req.user.id) throw badRequest('You cannot take your own task.')
  if (task.status !== 'OPEN') throw conflict('This task is no longer open.')

  const existing = task.assignments.find((a) => a.takerId === req.user.id)
  if (existing && existing.status !== 'WITHDRAWN') {
    throw conflict('You are already on this task.')
  }

  const taken = task.assignments.filter((a) => HOLDS_A_SPOT.includes(a.status)).length
  if (task.acceptanceMode === 'AUTO' && taken >= task.maxTakers) {
    throw conflict('No spots left.')
  }

  const status = task.acceptanceMode === 'AUTO' ? 'ACCEPTED' : 'APPLIED'
  const assignment = existing
    ? await prisma.taskAssignment.update({
        where: { id: existing.id },
        data: { status, appliedAt: new Date() },
      })
    : await prisma.taskAssignment.create({
        data: { taskId: task.id, takerId: req.user.id, status },
      })

  await emitTaskUpdated(task.id)
  res.status(201).json({ assignment })
})

/* --------------------------------------------------------------- check-in */

// The organizer side of D4: the code to project at the venue, derived from the
// event's secret and rotating every 60 seconds.
tasksRouter.get(
  '/tasks/:id/checkin-code',
  requireUser,
  validate({ params: idParam }),
  async (req, res) => {
    const task = await prisma.task.findUnique({ where: { id: req.valid.params.id } })
    if (!task || task.type !== 'EVENT') throw notFound('No event with that id.')
    if (!canManageCheckin(req.user, task)) throw forbidden('Only the organizers can see the code.')
    if (!task.checkinSecret) throw conflict('This event has no check-in secret.')

    res.json({
      code: currentCode(task.checkinSecret),
      remainingSeconds: remainingSeconds(),
      periodSeconds: STEP_SECONDS,
    })
  },
)

// The attendee side: a current code proves presence at the venue. A match is
// attendance, so the RSVP (an ACCEPTED assignment) completes on the spot.
tasksRouter.post(
  '/tasks/:id/checkin',
  requireUser,
  validate({ params: idParam, body: checkinBody }),
  async (req, res) => {
    const task = await prisma.task.findUnique({
      where: { id: req.valid.params.id },
      include: { assignments: true },
    })
    if (!task || task.type !== 'EVENT') throw notFound('No event with that id.')

    const mine = task.assignments.find((a) => a.takerId === req.user.id)
    if (!mine || (mine.status !== 'ACCEPTED' && mine.status !== 'COMPLETED')) {
      throw forbidden('Only accepted attendees can check in.')
    }
    if (mine.status === 'COMPLETED') throw conflict('You are already checked in.')

    // The error never says how close a guess was, or whether it was early or
    // late: one message for wrong and expired alike.
    if (!task.checkinSecret || !verify(task.checkinSecret, req.valid.body.code)) {
      throw new ApiError(400, 'BAD_CODE', 'That code is wrong or no longer current.')
    }

    const now = new Date()
    const assignment = await prisma.taskAssignment.update({
      where: { id: mine.id },
      data: {
        status: 'COMPLETED',
        completedAt: now,
        checkedInAt: now,
        checkedInBy: req.user.id,
      },
    })

    // Bring the task's own transitions (full -> LOCKED -> COMPLETED) current
    // the way the next request's settle pass would, so the fan-out is not
    // stale, then announce the new occupancy.
    const touched = await settle()
    for (const id of new Set([task.id, ...touched])) await emitTaskUpdated(id)
    res.json({ assignment })
  },
)

/* ---------------------------------------------------------------- calendar */

// D12: an "add to calendar" file, hand-rolled per RFC 5545.
tasksRouter.get(
  '/tasks/:id/calendar.ics',
  requireUser,
  validate({ params: idParam }),
  async (req, res) => {
    const task = await prisma.task.findUnique({ where: { id: req.valid.params.id } })
    if (!task || task.type !== 'EVENT') throw notFound('No event with that id.')

    const ics = icsForTask(task)
    if (!ics) throw badRequest('This event has no start time or deadline to put on a calendar.')

    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="aubounty-event.ics"',
    })
    res.send(ics)
  },
)
