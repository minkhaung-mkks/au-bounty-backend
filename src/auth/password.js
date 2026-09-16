import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

/**
 * Password hashing for the admin console sign-in, the one credential that does
 * not come from Microsoft. scrypt from node:crypto rather than a bcrypt/argon2
 * dependency: it is memory-hard, ships with the runtime, and needs no native
 * build step in the slim container image.
 *
 * Stored format (one column, self-describing so the cost can move later):
 *   scrypt$N$r$p$<salt base64url>$<derived key base64url>
 */

const scrypt = promisify(scryptCb)

// ~64 MB per hash at N=2^15, r=8. Node's default maxmem is 32 MB, so the cost
// is passed explicitly on both sides; a verify that forgot it would throw
// rather than return a wrong answer.
const PARAMS = { N: 32768, r: 8, p: 1 }
const KEY_LENGTH = 32
const SALT_BYTES = 16

const b64 = (buf) => buf.toString('base64url')

async function derive(password, salt, params) {
  const { N, r, p } = params
  return scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: 128 * N * r * 2,
  })
}

/** Hashes a plaintext password into the storable string above. */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('hashPassword needs a non-empty password.')
  }
  const salt = randomBytes(SALT_BYTES)
  const key = await derive(password, salt, PARAMS)
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${b64(salt)}$${b64(key)}`
}

/**
 * Constant-time verify. Every failure mode — no hash on the row, a malformed
 * column, the wrong password — returns false, so a caller cannot tell them
 * apart and neither can an attacker timing the response.
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false

  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const [, rawN, rawR, rawP, rawSalt, rawKey] = parts
  const params = { N: Number(rawN), r: Number(rawR), p: Number(rawP) }
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) {
    return false
  }

  const salt = Buffer.from(rawSalt, 'base64url')
  const expected = Buffer.from(rawKey, 'base64url')
  if (salt.length === 0 || expected.length === 0) return false

  try {
    const actual = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      ...params,
      maxmem: 128 * params.N * params.r * 2,
    })
    return timingSafeEqual(actual, expected)
  } catch {
    // Absurd cost parameters from a corrupted column land here.
    return false
  }
}

export const PASSWORD_PARAMS = PARAMS
