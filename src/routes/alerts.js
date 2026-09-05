import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { validate } from '../middleware/validate.js'
import { requireUser } from '../middleware/auth.js'
import { ApiError, unauthorized } from '../lib/errors.js'
import { forwardAlert } from '../lib/peerClient.js'

export const alertsRouter = Router()

const pressBody = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  message: z.string().trim().min(1).max(500).optional(),
})

/** Alert cooldown in minutes, ALERT_COOLDOWN_MIN, default 5. Zero is honored. */
function cooldownMinutes() {
  const parsed = Number(process.env.ALERT_COOLDOWN_MIN)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5
}

const serializeAlert = (a) => ({
  id: a.id,
  lat: a.lat,
  lng: a.lng,
  message: a.message ?? null,
  status: a.status,
  forwardedToPeer: a.forwardedToPeer,
  createdAt: a.createdAt,
  resolvedAt: a.resolvedAt ?? null,
})

/**
 * D6: the emergency button. Two rules guard it, both answering the same 409
 * payload so the UI has one cooldown path:
 *   - one ACTIVE alert per user (an unresolved alert cannot be superseded)
 *   - ALERT_COOLDOWN_MIN minutes since the user's most recent alert of ANY
 *     status, resolved or not, so rapid re-presses are one incident.
 * On success exactly one immediate forward attempt fires, unawaited: the
 * response never waits on the partner, and the sweeper owns later retries.
 */
alertsRouter.post('/alerts', requireUser, validate({ body: pressBody }), async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } })
  if (!user) throw unauthorized('Session points at a deleted user.')

  const mostRecent = await prisma.emergencyAlert.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  })

  if (mostRecent) {
    const hasActive = mostRecent.status === 'ACTIVE'
    const elapsed = Date.now() - mostRecent.createdAt.getTime()
    const cooldownMs = cooldownMinutes() * 60_000
    if (hasActive || elapsed < cooldownMs) {
      throw new ApiError(
        409,
        'ALERT_COOLDOWN',
        hasActive
          ? 'Your previous emergency alert is still active.'
          : 'You are pressing the emergency button too often.',
        {
          // Seconds until the cooldown lifts; an unresolved alert keeps the
          // button locked past that, which is what activeAlertId tells the UI.
          retryAfterSeconds:
            hasActive && elapsed >= cooldownMs
              ? 0
              : Math.ceil((cooldownMs - elapsed) / 1000),
          ...(hasActive ? { activeAlertId: mostRecent.id } : {}),
        },
      )
    }
  }

  const { lat, lng, message } = req.valid.body
  const alert = await prisma.emergencyAlert.create({
    data: { userId: user.id, lat, lng, message: message ?? null },
  })

  void forwardAlert(alert, user)
  res.status(201).json({ alert: serializeAlert(alert) })
})

/** Own history, newest first: what the button UI reads to show the cooldown. */
alertsRouter.get('/me/alerts', requireUser, async (req, res) => {
  const alerts = await prisma.emergencyAlert.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
  })
  res.json({ alerts: alerts.map(serializeAlert) })
})
