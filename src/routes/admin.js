import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { validate } from '../middleware/validate.js'
import { requireRole } from '../middleware/authorize.js'
import { conflict, notFound } from '../lib/errors.js'
import { userCard } from '../lib/serialize.js'

export const adminRouter = Router()

// The whole console is admin-only (D7). requireRole is the standard mount for
// role-gated routers; scoping it to the /admin prefix keeps the guard from
// leaking onto unrelated requests that fall through to this router.
adminRouter.use('/admin', requireRole('ADMIN'))

const idParam = z.object({ id: z.uuid() })
const roleBody = z.object({ role: z.enum(['STUDENT', 'TEACHER', 'ADMIN']) })
const orgBody = z.object({
  name: z.string().trim().min(1, 'Name cannot be empty.').max(80),
  description: z.string().trim().max(500).default(''),
})
// Patch keys are all optional, and absent must mean "leave it alone" — so this
// is spelled out rather than derived, keeping defaults out of the partial.
const orgPatchBody = z.object({
  name: z.string().trim().min(1, 'Name cannot be empty.').max(80).optional(),
  description: z.string().trim().max(500).optional(),
})
const memberBody = z.object({
  userId: z.uuid(),
  position: z.string().trim().min(1).max(80).default('Member'),
})
const tagBody = z.object({
  name: z.string().trim().min(1, 'Name cannot be empty.').max(40),
  category: z.enum(['LANGUAGE', 'ACADEMIC', 'PRACTICAL', 'ERRAND']),
})
// Query strings arrive as text; hidden is spelled out as an enum so "false"
// survives, instead of coerce.boolean() reading it as true.
const listUsersQuery = z.object({
  q: z.string().trim().max(80).optional(),
  role: z.enum(['STUDENT', 'TEACHER', 'ADMIN']).optional(),
})
const listReviewsQuery = z.object({
  hidden: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

/** Only the fields the alert console renders; identity stays a card, not a row. */
const serializeAlert = (a) => ({
  id: a.id,
  user: a.user,
  lat: a.lat,
  lng: a.lng,
  message: a.message,
  status: a.status,
  forwardedToPeer: a.forwardedToPeer,
  createdAt: a.createdAt,
  resolvedAt: a.resolvedAt,
})

const alertInclude = { user: { select: { id: true, name: true, universityId: true } } }

/* ------------------------------------------------------------- directory */

// The role picker's search surface. SERVICE accounts are integration identity,
// not people, so they never appear here regardless of filters.
adminRouter.get('/admin/users', validate({ query: listUsersQuery }), async (req, res) => {
  const { q, role } = req.valid.query
  const where = { role: role ?? { not: 'SERVICE' } }
  if (q) {
    where.OR = ['name', 'email', 'universityId'].map((field) => ({
      [field]: { contains: q, mode: 'insensitive' },
    }))
  }
  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, name: true, email: true, universityId: true, role: true, createdAt: true },
  })
  res.json({ users })
})

/* ------------------------------------------------------------------ roles */

// SERVICE accounts belong to the peer integration, not to people; nobody logs
// in as one, so promoting or demoting one can only be a mistake.
adminRouter.patch(
  '/admin/users/:id/role',
  validate({ params: idParam, body: roleBody }),
  async (req, res) => {
    const { id } = req.valid.params
    if (id === req.user.id) throw conflict('You cannot change your own role.')

    const target = await prisma.user.findUnique({ where: { id } })
    if (!target) throw notFound('No user with that id.')
    if (target.role === 'SERVICE') throw conflict('Service accounts keep their role.')

    const updated = await prisma.user.update({ where: { id }, data: { role: req.valid.body.role } })
    res.json({
      user: { ...userCard(updated), email: updated.email, createdAt: updated.createdAt },
    })
  },
)

/* ------------------------------------------------------------------- orgs */

adminRouter.get('/admin/orgs', async (req, res) => {
  const orgs = await prisma.organization.findMany({
    include: { _count: { select: { memberships: true } } },
    orderBy: { name: 'asc' },
  })
  res.json({
    orgs: orgs.map((o) => ({
      id: o.id,
      name: o.name,
      description: o.description,
      memberCount: o._count.memberships,
    })),
  })
})

adminRouter.get('/admin/orgs/:id', validate({ params: idParam }), async (req, res) => {
  const org = await prisma.organization.findUnique({
    where: { id: req.valid.params.id },
    include: { memberships: { include: { user: true }, orderBy: { user: { name: 'asc' } } } },
  })
  if (!org) throw notFound('No organization with that id.')
  res.json({
    org: { id: org.id, name: org.name, description: org.description },
    members: org.memberships.map((m) => ({
      userId: m.userId,
      name: m.user.name,
      position: m.position,
    })),
  })
})

adminRouter.post('/admin/orgs', validate({ body: orgBody }), async (req, res) => {
  let org
  try {
    org = await prisma.organization.create({ data: req.valid.body })
  } catch (err) {
    if (err?.code === 'P2002') throw conflict('An organization with that name already exists.')
    throw err
  }
  res.status(201).json({ org })
})

adminRouter.patch(
  '/admin/orgs/:id',
  validate({ params: idParam, body: orgPatchBody }),
  async (req, res) => {
    const { name, description } = req.valid.body
    let org
    try {
      // Prisma skips undefined keys, so absent fields keep their stored value.
      org = await prisma.organization.update({
        where: { id: req.valid.params.id },
        data: { name, description },
      })
    } catch (err) {
      if (err?.code === 'P2025') throw notFound('No organization with that id.')
      if (err?.code === 'P2002') throw conflict('An organization with that name already exists.')
      throw err
    }
    res.json({ org })
  },
)

adminRouter.post(
  '/admin/orgs/:id/members',
  validate({ params: idParam, body: memberBody }),
  async (req, res) => {
    const orgId = req.valid.params.id
    const { userId, position } = req.valid.body

    const [org, user] = await Promise.all([
      prisma.organization.findUnique({ where: { id: orgId } }),
      prisma.user.findUnique({ where: { id: userId } }),
    ])
    if (!org) throw notFound('No organization with that id.')
    if (!user) throw notFound('No user with that id.')

    let membership
    try {
      membership = await prisma.orgMembership.create({ data: { orgId, userId, position } })
    } catch (err) {
      if (err?.code === 'P2002') throw conflict('That user is already a member of this organization.')
      throw err
    }
    res.status(201).json({ membership })
  },
)

adminRouter.delete(
  '/admin/orgs/:id/members/:userId',
  validate({ params: z.object({ id: z.uuid(), userId: z.uuid() }) }),
  async (req, res) => {
    const { id: orgId, userId } = req.valid.params
    const existing = await prisma.orgMembership.findUnique({
      where: { userId_orgId: { userId, orgId } },
    })
    if (!existing) throw notFound('That user is not a member of this organization.')

    await prisma.orgMembership.delete({ where: { id: existing.id } })
    res.status(204).send()
  },
)

/* ------------------------------------------------------------------- tags */

adminRouter.post('/admin/tags', validate({ body: tagBody }), async (req, res) => {
  let tag
  try {
    tag = await prisma.tag.create({ data: req.valid.body })
  } catch (err) {
    if (err?.code === 'P2002') throw conflict('A tag with that name already exists.')
    throw err
  }
  res.status(201).json({ tag })
})

/* ------------------------------------------------------------ moderation */

// Hiding the wording is moderation, not deletion: the rating keeps counting in
// the public average, only the text goes away (see GET /users/:id).
adminRouter.patch(
  '/admin/reviews/:id/hide-text',
  validate({ params: idParam, body: z.object({ hidden: z.boolean() }) }),
  async (req, res) => {
    const { id } = req.valid.params
    const existing = await prisma.review.findUnique({ where: { id } })
    if (!existing) throw notFound('No review with that id.')

    const review = await prisma.review.update({
      where: { id },
      data: { textHidden: req.valid.body.hidden },
    })
    res.json({ review })
  },
)

// The moderation queue: newest first, filterable to the hidden ones. Admins see
// the raw text here — that is the point of reviewing what was hidden.
adminRouter.get('/admin/reviews', validate({ query: listReviewsQuery }), async (req, res) => {
  const { hidden, limit } = req.valid.query
  const reviews = await prisma.review.findMany({
    where: hidden === undefined ? undefined : { textHidden: hidden },
    include: {
      reviewer: { select: { id: true, name: true } },
      reviewee: { select: { id: true, name: true } },
      task: { select: { id: true, title: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  res.json({
    reviews: reviews.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      taskTitle: r.task.title,
      reviewer: r.reviewer,
      reviewee: r.reviewee,
      rating: r.rating,
      text: r.text,
      textHidden: r.textHidden,
      createdAt: r.createdAt,
    })),
  })
})

/* ---------------------------------------------------------------- alerts */

adminRouter.get(
  '/admin/alerts',
  validate({ query: z.object({ status: z.enum(['ACTIVE', 'RESOLVED', 'FLAGGED']).optional() }) }),
  async (req, res) => {
    const { status } = req.valid.query
    const alerts = await prisma.emergencyAlert.findMany({
      where: status ? { status } : undefined,
      include: alertInclude,
      orderBy: { createdAt: 'desc' },
    })
    res.json({ alerts: alerts.map(serializeAlert) })
  },
)

// Only closing moves exist: an alert is resolved or flagged out of the active
// queue, never reopened from here. resolvedAt records the first resolution and
// survives a later flag, so the timeline stays honest.
adminRouter.patch(
  '/admin/alerts/:id',
  validate({ params: idParam, body: z.object({ status: z.enum(['RESOLVED', 'FLAGGED']) }) }),
  async (req, res) => {
    const { status } = req.valid.body
    const existing = await prisma.emergencyAlert.findUnique({ where: { id: req.valid.params.id } })
    if (!existing) throw notFound('No alert with that id.')

    const data = { status }
    if (status === 'RESOLVED' && existing.resolvedAt == null) data.resolvedAt = new Date()

    const alert = await prisma.emergencyAlert.update({
      where: { id: existing.id },
      data,
      include: alertInclude,
    })
    res.json({ alert: serializeAlert(alert) })
  },
)
