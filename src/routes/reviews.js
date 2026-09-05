import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { validate } from '../middleware/validate.js'
import { requireUser } from '../middleware/auth.js'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js'

export const reviewsRouter = Router()

const createBody = z.object({
  taskId: z.uuid(),
  revieweeId: z.uuid(),
  rating: z.number().int().min(1).max(5),
  text: z.string().trim().max(2000).default(''),
})

/**
 * Both sides of a finished Request or Emergency review each other. Events skip
 * reviews entirely: attendance is the only check that means anything there.
 *
 * The review is stored unpublished. settle() publishes it once the double-blind
 * window closes, so neither side can read the other's rating in time to retaliate.
 */
reviewsRouter.post('/reviews', requireUser, validate({ body: createBody }), async (req, res) => {
  const { taskId, revieweeId, rating, text } = req.valid.body
  const me = req.user.id
  if (revieweeId === me) throw badRequest('You cannot review yourself.')

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { assignments: true },
  })
  if (!task) throw notFound('No task with that id.')
  if (task.type === 'EVENT') throw badRequest('Events do not take reviews.')

  const completed = task.assignments.filter((a) => a.status === 'COMPLETED')
  const pairIsValid =
    (task.posterId === me && completed.some((a) => a.takerId === revieweeId)) ||
    (task.posterId === revieweeId && completed.some((a) => a.takerId === me))
  if (!pairIsValid) {
    throw forbidden('Reviews are only allowed between the poster and a taker who completed.')
  }

  const already = await prisma.review.findFirst({
    where: { taskId, reviewerId: me, revieweeId },
  })
  if (already) throw conflict('You already reviewed them for this task.')

  const review = await prisma.review.create({
    data: { taskId, reviewerId: me, revieweeId, rating, text, published: false },
  })
  res.status(201).json({
    review,
    note: 'Sealed. It publishes 1 day after both sides submit, or 7 days after only one has.',
  })
})
