import { prisma } from '../lib/prisma.js'
import { unauthorized } from '../lib/errors.js'

/**
 * v0.5 stand-in for real authentication.
 *
 * The frontend sign-in screen lists the seeded users and stores the chosen id
 * in localStorage, then sends it as `x-dev-user-id` on every request. This
 * middleware turns that header into `req.user`, exactly the way JWT middleware
 * will once Microsoft sign-in lands. Everything downstream reads `req.user`
 * and does not care where it came from.
 *
 * Replacing this file with token verification is the whole of the auth change.
 */
export async function devAuth(req, res, next) {
  const id = req.get('x-dev-user-id')
  req.user = null
  if (!id) return next()

  const user = await prisma.user.findUnique({
    where: { id },
    include: { memberships: { include: { org: true } } },
  })
  if (!user) return next()

  req.user = {
    ...user,
    orgIds: user.memberships.map((m) => m.orgId),
    isOrgMember: user.memberships.length > 0,
  }
  next()
}

export function requireUser(req, res, next) {
  if (!req.user) return next(unauthorized())
  next()
}
