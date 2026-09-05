import { SignJWT, jwtVerify } from 'jose'

export const TOKEN_COOKIE = 'aubounty_token'
export const TOKEN_TTL_SECONDS = 60 * 60

function secretKey() {
  const secret = process.env.JWT_SECRET
  // An unset secret must degrade to "everyone unauthenticated", never crash.
  return secret ? new TextEncoder().encode(secret) : null
}

/** Issues our own session JWT: HS256, 1h, payload { sub, role, name, orgIds }. */
export async function signSessionToken(user) {
  const key = secretKey()
  if (!key) throw new Error('JWT_SECRET is not configured.')
  return new SignJWT({ role: user.role, name: user.name, orgIds: user.orgIds })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(key)
}

/** Signature-and-expiry verification only; anything else means unauthenticated. */
export async function verifySessionToken(token) {
  const key = secretKey()
  if (!key || typeof token !== 'string') return null
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] })
    return payload
  } catch {
    return null
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/aubounty',
    maxAge: TOKEN_TTL_SECONDS * 1000,
    secure: process.env.COOKIE_SECURE === 'true',
  }
}
