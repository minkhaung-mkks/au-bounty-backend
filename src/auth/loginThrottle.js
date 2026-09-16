/**
 * In-process throttle for the admin password form. A password endpoint with no
 * rate limit is an offline brute force with extra steps, and scrypt alone only
 * slows one guess down.
 *
 * Deliberately in-memory: one API process today, and a restart clearing the
 * counters is a smaller problem than a Redis dependency. Move this to a shared
 * store before running more than one replica.
 */

const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILURES = 8

const failures = new Map() // key -> { count, firstAt, until }

const now = () => Date.now()

/** Drops entries whose window has passed, so the map cannot grow unbounded. */
function sweep(at) {
  for (const [key, entry] of failures) {
    if (at - entry.firstAt > WINDOW_MS) failures.delete(key)
  }
}

/** Seconds the caller must wait, or 0 when they may try now. */
export function retryAfterSeconds(key, at = now()) {
  const entry = failures.get(key)
  if (!entry) return 0
  if (at - entry.firstAt > WINDOW_MS) {
    failures.delete(key)
    return 0
  }
  if (entry.count < MAX_FAILURES) return 0
  return Math.ceil((entry.firstAt + WINDOW_MS - at) / 1000)
}

export function recordFailure(key, at = now()) {
  sweep(at)
  const entry = failures.get(key)
  if (!entry || at - entry.firstAt > WINDOW_MS) {
    failures.set(key, { count: 1, firstAt: at })
    return
  }
  entry.count += 1
}

export function clearFailures(key) {
  failures.delete(key)
}

/** Test seam: nothing in the app resets the counters mid-run. */
export function resetThrottle() {
  failures.clear()
}

export const THROTTLE_WINDOW_MS = WINDOW_MS
export const THROTTLE_MAX_FAILURES = MAX_FAILURES
