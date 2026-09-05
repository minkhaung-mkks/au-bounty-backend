import { Router } from 'express'
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { validate } from '../middleware/validate.js'
import { ApiError } from '../lib/errors.js'
import { serializeTask, taskInclude } from '../lib/serialize.js'
import { emitTaskCreated } from '../realtime/emit.js'

export const peerRouter = Router()

const inboundBody = z.object({
  // The partner's own id for the incident. Unique per campus alert system.
  externalRef: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(5000),
  locationName: z.string().trim().max(200).optional(),
  locationLat: z.number().min(-90).max(90).optional(),
  locationLng: z.number().min(-180).max(180).optional(),
  rewardDescription: z.string().trim().max(200).optional(),
  maxTakers: z.number().int().min(1).max(50).default(5),
})

/**
 * The inbound endpoint's whole security domain is a shared secret in a header,
 * not a user session, so this router mounts before the user-resolution
 * middleware. The comparison is constant-time; both sides are digested first
 * so a length difference cannot short-circuit it.
 */
function requirePeerKey(req, res, next) {
  const expected = process.env.PEER_INBOUND_API_KEY
  if (!expected) {
    return next(
      new ApiError(503, 'PEER_API_UNCONFIGURED', 'The peer inbound API key is not configured.'),
    )
  }
  const given = req.get('x-api-key') ?? ''
  const givenHash = createHash('sha256').update(given).digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  if (!timingSafeEqual(givenHash, expectedHash)) {
    return next(new ApiError(401, 'UNAUTHORIZED', 'Invalid peer API key.'))
  }
  next()
}

/**
 * D6 inbound: an emergency the partner campus system pushes to us. It becomes
 * an EMERGENCY task owned by the seeded SERVICE account (first come, first
 * helped: AUTO acceptance, no review reward), deduplicated on externalRef so a
 * partner retry can never double-post an incident.
 */
peerRouter.post(
  '/peer/emergency-tasks',
  requirePeerKey,
  validate({ body: inboundBody }),
  async (req, res) => {
    const body = req.valid.body

    const service = await prisma.user.findFirst({ where: { role: 'SERVICE' } })
    if (!service) {
      throw new ApiError(503, 'SERVICE_USER_MISSING', 'The SERVICE account is not seeded.')
    }

    let task
    try {
      task = await prisma.task.create({
        data: {
          title: body.title,
          content: body.content,
          type: 'EMERGENCY',
          posterId: service.id,
          externalRef: body.externalRef,
          rewardType: body.rewardDescription ? 'OTHER' : 'NONE',
          rewardDescription: body.rewardDescription ?? '',
          maxTakers: body.maxTakers,
          acceptanceMode: 'AUTO',
          locationName: body.locationName ?? '',
          locationLat: body.locationLat ?? null,
          locationLng: body.locationLng ?? null,
        },
        include: taskInclude,
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await prisma.task.findUnique({
          where: { externalRef: body.externalRef },
          select: { id: true },
        })
        throw new ApiError(409, 'DUPLICATE_EXTERNAL_REF', 'A task already exists for this externalRef.', {
          existingTaskId: existing?.id ?? null,
        })
      }
      throw err
    }

    // The single creation hook: fans emergency:new out to the emergencies room.
    emitTaskCreated(task)
    res.status(201).json({ task: serializeTask(task, null) })
  },
)
