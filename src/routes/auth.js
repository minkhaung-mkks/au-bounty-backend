import { Router } from 'express'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { ENTRA_SCOPES, isEntraConfigured, msalClient, redirectUri } from '../auth/entra.js'
import { identityFromEmail } from '../auth/auIdentity.js'
import { parseCookies } from '../auth/cookies.js'
import { decodeState, encodeState, postLoginRedirect } from '../auth/returnTo.js'
import {
  NONCE_COOKIE,
  TOKEN_COOKIE,
  nonceCookieOptions,
  sessionCookieOptions,
  signSessionToken,
} from '../auth/session.js'

export const authRouter = Router()

const notConfigured = (res) => res.status(503).json({ error: 'auth not configured' })

/** Constant-time compare for equal-length secrets; mismatched lengths say no. */
function secretsMatch(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  return bufA.length === bufB.length && bufA.length > 0 && timingSafeEqual(bufA, bufB)
}

/* ------------------------------------------------------------------ login */

authRouter.get('/auth/login', async (req, res, next) => {
  if (!isEntraConfigured()) return notConfigured(res)
  try {
    // returnTo rides through Microsoft inside the state blob, sanitized first:
    // an attacker-supplied absolute URL must never become our redirect target.
    // The nonce joins it, and a copy is dropped as a short-lived cookie; the
    // callback only honors state whose nonce matches that cookie, so a flow an
    // attacker started themselves cannot end in our session cookie.
    const nonce = randomBytes(16).toString('base64url')
    const url = await msalClient().getAuthCodeUrl({
      scopes: ENTRA_SCOPES,
      redirectUri: redirectUri(),
      state: encodeState(req.query.returnTo, nonce),
    })
    res.cookie(NONCE_COOKIE, nonce, nonceCookieOptions())
    res.redirect(302, url)
  } catch (err) {
    next(err)
  }
})

/* --------------------------------------------------------------- callback */

authRouter.get('/auth/callback', async (req, res, next) => {
  if (!isEntraConfigured()) return notConfigured(res)
  // The nonce is spent the moment the callback runs, whatever happens next.
  const { path, ...clearOptions } = nonceCookieOptions()
  res.clearCookie(NONCE_COOKIE, { path, ...clearOptions })
  try {
    if (req.query.error) {
      return res.status(401).json({
        error: { code: 'AUTH_FAILED', message: String(req.query.error_description ?? req.query.error) },
      })
    }

    // Login CSRF guard: the state must carry the nonce this server issued in
    // the aubounty_oauth_nonce cookie. Missing on either side, or a mismatch,
    // means the authorization request did not come from our /auth/login.
    const { returnTo, nonce } = decodeState(req.query.state)
    const cookieNonce = parseCookies(req.get('cookie'))[NONCE_COOKIE]
    if (!nonce || !cookieNonce || !secretsMatch(nonce, cookieNonce)) {
      return res.status(401).json({
        error: {
          code: 'AUTH_FAILED',
          message: 'The login attempt expired or did not start here. Sign in again.',
        },
      })
    }

    const result = await msalClient().acquireTokenByCode({
      code: String(req.query.code ?? ''),
      redirectUri: redirectUri(),
      scopes: ENTRA_SCOPES,
    })

    const user = await upsertMicrosoftUser(result)
    const orgs = await prisma.orgMembership.findMany({
      where: { userId: user.id },
      select: { orgId: true },
    })

    const token = await signSessionToken({
      id: user.id,
      role: user.role,
      name: user.name,
      orgIds: orgs.map((m) => m.orgId),
    })
    res.cookie(TOKEN_COOKIE, token, sessionCookieOptions())
    res.redirect(302, postLoginRedirect(returnTo))
  } catch (err) {
    next(err)
  }
})

/**
 * Maps an id_token to our User table. oid is the stable key; name and email
 * follow whatever the directory says today. No Microsoft tokens are stored.
 *
 * Role and student id come from the AU address shape when the directory does
 * not publish an employeeId claim, so u6712164@au.edu signs in as a STUDENT
 * carrying 6712164 and never sees the "set once" form.
 */
async function upsertMicrosoftUser(result) {
  const claims = result.idTokenClaims ?? {}
  const oid = claims.oid ?? result.uniqueId
  if (!oid) throw new Error('id_token carried no oid claim.')

  const name = claims.name ?? claims.preferred_username ?? claims.email ?? 'Microsoft user'
  const email =
    claims.preferred_username ?? claims.email ?? `${oid}@unset.au-bounty.invalid`
  // A real directory claim outranks the address pattern; the pattern is the
  // fallback, and both leave the set-once rule below untouched.
  const derived = identityFromEmail(email)
  const universityId =
    claims.employeeId ?? claims.extension_employeeId ?? derived.universityId

  const existing = await prisma.user.findUnique({ where: { msadOid: oid } })
  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        name,
        email,
        // A claim-sourced universityId only fills an empty slot, never moves
        // one that was already claimed (same set-once rule as PUT /me).
        ...(existing.universityId === null && universityId ? { universityId } : {}),
      },
    })
  }

  try {
    return await prisma.user.create({
      data: { msadOid: oid, name, email, universityId, role: derived.role },
    })
  } catch (err) {
    // The directory email matched a user created some other way (seed, peer
    // import). Claim that row rather than failing the sign-in.
    if (err?.code === 'P2002') {
      // A derived id someone else already owns must not cost anyone their
      // sign-in: drop it and let the profile form claim one by hand.
      if (String(err?.meta?.target ?? '').includes('universityId')) {
        return prisma.user.create({
          data: { msadOid: oid, name, email, role: derived.role },
        })
      }
      const byEmail = await prisma.user.findUnique({ where: { email } })
      if (byEmail && byEmail.msadOid === null) {
        return prisma.user.update({
          where: { id: byEmail.id },
          data: { msadOid: oid, name, universityId: byEmail.universityId ?? universityId },
        })
      }
    }
    throw err
  }
}

/* ------------------------------------------------------------------ logout */

authRouter.get('/auth/logout', (req, res) => {
  const { path, ...options } = sessionCookieOptions()
  res.clearCookie(TOKEN_COOKIE, { path, ...options })
  res.status(204).end()
})
