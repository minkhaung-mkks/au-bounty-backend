import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Hand-rolled TOTP (RFC 6238, HMAC-SHA1, 6 digits) with a 60-second step
 * instead of the standard 30: the proposal's "code rotates every 60 seconds".
 * No dependencies, no network, no clock reads hidden inside — every function
 * takes an explicit timestamp so tests can freeze time.
 */

export const STEP_SECONDS = 60
export const DIGITS = 6

const isHex = (s) => s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)

/**
 * The stored secret becomes the raw HMAC key. Task creation stores
 * randomBytes().toString('hex'), so hex-looking secrets are hex-decoded back to
 * their original bytes; anything else (the seed's literal 'SEEDSECRET…'
 * strings) is used as its utf8 bytes.
 */
export function keyBytes(secret) {
  return isHex(secret) ? Buffer.from(secret, 'hex') : Buffer.from(secret, 'utf8')
}

/** The TOTP step a timestamp falls into (epoch seconds / step). */
export const stepIndex = (at = Date.now()) => Math.floor(at / 1000 / STEP_SECONDS)

/** Seconds until the current code expires; 60 on a fresh step boundary. */
export const remainingSeconds = (at = Date.now()) =>
  STEP_SECONDS - (Math.floor(at / 1000) % STEP_SECONDS)

/** The code for one specific step. */
export function codeAt(secret, step) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const digest = createHmac('sha1', keyBytes(secret)).update(counter).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const bin =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3]
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0')
}

/** The code an organizer should display right now. */
export const currentCode = (secret, at = Date.now()) => codeAt(secret, stepIndex(at))

function sameLengthDigits(a, b) {
  if (typeof b !== 'string' || b.length !== DIGITS) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/**
 * True when `code` matches the secret within +/- `tolerance` steps of `at`.
 * Constant-time per candidate and deliberately boolean-only: the caller must
 * never learn which step matched or how close a guess was.
 */
export function verify(secret, code, at = Date.now(), tolerance = 1) {
  const current = stepIndex(at)
  for (let drift = -tolerance; drift <= tolerance; drift++) {
    if (sameLengthDigits(codeAt(secret, current + drift), code)) return true
  }
  return false
}
