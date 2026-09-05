import { prisma } from '../lib/prisma.js'
import { forwardAlert } from '../lib/peerClient.js'

export const SWEEP_INTERVAL_MS = 30_000

/**
 * D6 outbound retry loop. The press itself triggers exactly one immediate
 * forward attempt; this sweeper owns every attempt after that, the same lazy
 * philosophy as the settle engine but proactive: an alert the partner missed
 * (downtime, timeout) is retried until it lands or the alert stops being
 * ACTIVE. Failures log at warn and never throw.
 */

let timer = null
let sweeping = false

/** One pass: forward every ACTIVE alert the partner has not acknowledged. */
export async function sweepAlerts() {
  if (!process.env.PEER_OUTBOUND_URL) return 0
  const pending = await prisma.emergencyAlert.findMany({
    where: { forwardedToPeer: false, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    include: { user: true },
  })
  let forwarded = 0
  for (const alert of pending) {
    if (await forwardAlert(alert, alert.user)) forwarded += 1
  }
  return forwarded
}

async function runSweep() {
  if (sweeping) return // a slow pass must not stack on itself
  sweeping = true
  try {
    await sweepAlerts()
  } catch (err) {
    console.warn('alert sweep failed:', err.message)
  } finally {
    sweeping = false
  }
}

/** Runs an immediate pass, then every SWEEP_INTERVAL_MS. Safe to call twice. */
export function startAlertSweeper() {
  if (timer) return
  runSweep()
  timer = setInterval(runSweep, SWEEP_INTERVAL_MS)
  timer.unref?.() // the HTTP server owns the process lifetime, not this loop
}

export function stopAlertSweeper() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
