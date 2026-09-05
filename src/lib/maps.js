/**
 * D9 maps integration. Both functions read GOOGLE_MAPS_KEY at call time so the
 * environment (and tests) can flip the capability live. With no key, geocode
 * answers null and the routes fall back to manual coordinates; a static map
 * URL is only ever produced with a key, so the frontend keeps its placeholder
 * graphic otherwise.
 */

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'
const GEOCODE_TIMEOUT_MS = 5_000

/**
 * Resolve a location name to coordinates. Returns { lat, lng } for the first
 * result, or null when there is no key, zero results, or the API is slow/down
 * (timeout, network error, non-200, unexpected body). Null always means "the
 * caller must fall back to manual coordinates", never "throw".
 */
export async function geocode(locationName) {
  const key = process.env.GOOGLE_MAPS_KEY
  if (!key || !locationName) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS)
  try {
    const url = `${GEOCODE_URL}?address=${encodeURIComponent(locationName)}&key=${key}`
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    const data = await response.json()
    const first = data?.results?.[0]?.geometry?.location
    if (typeof first?.lat !== 'number' || typeof first?.lng !== 'number') return null
    return { lat: first.lat, lng: first.lng }
  } catch {
    return null // includes the 5s abort: a geocode outage never blocks creation
  } finally {
    clearTimeout(timeout)
  }
}

/** Static map thumbnail URL for stored coordinates, or null without a key. */
export function staticMapUrl(lat, lng) {
  const key = process.env.GOOGLE_MAPS_KEY
  if (!key || lat == null || lng == null) return null
  const params = new URLSearchParams({
    center: `${lat},${lng}`,
    zoom: '15',
    size: '640x320',
    scale: '2',
    markers: `${lat},${lng}`,
    key,
  })
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`
}
