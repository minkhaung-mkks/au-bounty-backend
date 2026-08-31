import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { validate } from '../middleware/validate.js'

export const devRouter = Router()

/**
 * Everything in this file exists only until Microsoft sign-in lands, and is meant
 * to be deleted then. Nothing else in the codebase imports it.
 */

/** The sign-in screen's user picker. */
devRouter.get('/dev/users', async (req, res) => {
  const users = await prisma.user.findMany({
    where: { role: { not: 'SERVICE' } },
    include: { memberships: { include: { org: true } } },
    orderBy: { universityId: 'asc' },
  })
  res.json({
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      universityId: u.universityId,
      role: u.role,
      orgs: u.memberships.map((m) => ({ name: m.org.name, position: m.position })),
    })),
  })
})

/**
 * Shifts the clock-sensitive timestamps backwards so the 7-day auto-confirm and
 * the review publish window can be demonstrated without waiting a week. The next
 * request's settle() pass then applies whatever became due.
 */
devRouter.post(
  '/dev/advance-clock',
  validate({ body: z.object({ days: z.number().int().min(1).max(365).default(7) }) }),
  async (req, res) => {
    const { days } = req.valid.body

    const assignments = await prisma.$executeRaw`
      UPDATE "TaskAssignment"
      SET "completionRequestedAt" = "completionRequestedAt" - make_interval(days => ${days})
      WHERE "completionRequestedAt" IS NOT NULL AND "status" = 'PENDING_CONFIRMATION'
    `
    const reviews = await prisma.$executeRaw`
      UPDATE "Review"
      SET "createdAt" = "createdAt" - make_interval(days => ${days})
      WHERE "published" = false
    `

    res.json({
      movedBackDays: days,
      touched: { assignments, reviews },
      note: 'settle() applies whatever is now due on the next request.',
    })
  },
)
