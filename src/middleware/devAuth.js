import { prisma } from '../lib/prisma.js'

/**
 * Dev sign-in stand-in, mounted (with the /dev routes) only when DEV_AUTH=1.
 *
 * The frontend sign-in screen lists the seeded users and stores the chosen id
 * in localStorage, then sends it as `x-dev-user-id` on every request. This
 * middleware turns that header into the same req.user shape the real cookie
 * middleware produces, so nothing downstream can tell the two apart:
 *   { id, role, name, orgIds, isOrgMember }
 *
 * A valid session cookie always wins over the dev header: the cookie path is
 * the real one, and mixing the two mid-session would be more confusing than
 * useful in demos.
 */
export async function devAuth(req, res, next) {
  if (req.user) return next()

  const id = req.get('x-dev-user-id')
  if (!id) return next()

  const user = await prisma.user.findUnique({
    where: { id },
    include: { memberships: true },
  })
  if (!user) return next()

  req.user = {
    id: user.id,
    role: user.role,
    name: user.name,
    orgIds: user.memberships.map((m) => m.orgId),
    isOrgMember: user.memberships.length > 0,
  }
  next()
}
