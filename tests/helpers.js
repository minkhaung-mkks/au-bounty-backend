import { createApp } from '../src/app.js'
import { prisma } from '../src/lib/prisma.js'
import { signSessionToken } from '../src/auth/session.js'

export const TEST_TENANT_ID = '11111111-1111-1111-1111-111111111111'
export const TEST_CLIENT_ID = '22222222-2222-2222-2222-222222222222'
export const CALLBACK_BASE = 'http://localhost:4000/aubounty/api'

const TABLES = [
  'Attachment',
  'Message',
  'EmailOutbox',
  'EmergencyAlert',
  'Review',
  'TaskAssignment',
  'TaskTag',
  'UserTag',
  'Task',
  'OrgMembership',
  'Organization',
  'Tag',
  'User',
]

/** Wipes the test database between tests; order matches FK dependencies. */
export async function resetDb() {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`)
}

/**
 * Builds an app with a controlled auth environment. Default is the dev shape
 * (DEV_AUTH=1, entra unconfigured); pass entraSecret to make login live.
 */
export function appWith({ dev = true, entraSecret = '', appOrigin = '' } = {}) {
  process.env.ENTRA_CLIENT_SECRET = entraSecret
  process.env.APP_ORIGIN = appOrigin
  if (dev) process.env.DEV_AUTH = '1'
  else delete process.env.DEV_AUTH
  return createApp()
}

export async function createUser(overrides = {}) {
  const { orgIds = [], ...user } = overrides
  const created = await prisma.user.create({
    data: { name: 'Test User', email: `${crypto.randomUUID()}@test.dev`, ...user },
  })
  for (const orgId of orgIds) {
    await prisma.orgMembership.create({ data: { userId: created.id, orgId } })
  }
  return created
}

/** A ready-to-send Cookie header for the given user row. */
export async function sessionCookie(user) {
  const memberships = await prisma.orgMembership.findMany({
    where: { userId: user.id },
    select: { orgId: true },
  })
  const token = await signSessionToken({
    id: user.id,
    role: user.role,
    name: user.name,
    orgIds: memberships.map((m) => m.orgId),
  })
  return `aubounty_token=${token}`
}
