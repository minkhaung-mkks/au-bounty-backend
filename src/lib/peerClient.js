import { prisma } from './prisma.js'

const FORWARD_TIMEOUT_MS = 10_000

/**
 * Outbound half of the SL Systems peer contract (D6). One best-effort attempt
 * to hand an emergency alert to the partner: never throws, and the only side
 * effect of a 2xx is flipping forwardedToPeer on the alert row. The route that
 * creates an alert fires this unawaited, and the sweeper calls it again on
 * every retry pass, so a partner hiccup can never lose an alert or fail a
 * student's press.
 */
export async function forwardAlert(alert, user) {
  const baseUrl = process.env.PEER_OUTBOUND_URL
  if (!baseUrl) return false

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/peer/emergency-alerts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.PEER_OUTBOUND_API_KEY ?? '',
      },
      body: JSON.stringify({
        universityId: user.universityId ?? null,
        name: user.name,
        email: user.email,
        lat: alert.lat,
        lng: alert.lng,
        message: alert.message ?? null,
        pressedAt: alert.createdAt,
      }),
      signal: controller.signal,
    })
    const body = await response.text() // drain it: the partner is a keep-alive peer
    if (!response.ok) {
      console.warn(`peer forward of alert ${alert.id} failed: partner answered ${response.status}`)
      return false
    }
    await prisma.emergencyAlert.update({
      where: { id: alert.id },
      data: { forwardedToPeer: true },
    })
    return true
  } catch (err) {
    console.warn(`peer forward of alert ${alert.id} failed: ${err.message}`)
    return false
  } finally {
    clearTimeout(timeout)
  }
}
