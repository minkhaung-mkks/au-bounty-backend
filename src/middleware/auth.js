import { parseCookies } from '../auth/cookies.js'
import { TOKEN_COOKIE, verifySessionToken } from '../auth/session.js'
import { unauthorized } from '../lib/errors.js'

/**
 * Real authentication: verifies the aubounty_token session cookie by signature
 * and expiry only, with no database lookup (the proposal's trade-off: revoking
 * a session means waiting out the 1h TTL or rotating JWT_SECRET).
 *
 * Sets the same req.user shape as the dev picker in devAuth.js, so every
 * downstream guard and handler stays source-agnostic:
 *   { id, role, name, orgIds, isOrgMember }
 */
export async function cookieAuth(req, res, next) {
  req.user = null
  const token = parseCookies(req.get('cookie'))[TOKEN_COOKIE]
  if (!token) return next()

  const payload = await verifySessionToken(token)
  if (!payload?.sub || !payload.role) return next()

  const orgIds = Array.isArray(payload.orgIds) ? payload.orgIds : []
  req.user = {
    id: payload.sub,
    role: payload.role,
    name: payload.name ?? '',
    orgIds,
    isOrgMember: orgIds.length > 0,
  }
  next()
}

export function requireUser(req, res, next) {
  if (!req.user) return next(unauthorized('Sign in first.'))
  next()
}
