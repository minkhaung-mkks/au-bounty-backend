import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import request from 'supertest'

import { prisma } from '../src/lib/prisma.js'
import { hashPassword, verifyPassword } from '../src/auth/password.js'
import { resetThrottle, THROTTLE_MAX_FAILURES } from '../src/auth/loginThrottle.js'
import { seedAdmins, ADMIN_ACCOUNTS } from '../prisma/seedAdmins.js'
import { appWith, createUser, resetDb } from './helpers.js'

const LOGIN = '/aubounty/api/auth/admin/login'
const PASSWORD = 'admin123'

// The seed reads these, and one test overrides them; every test starts from a
// known environment rather than whatever the previous one left behind.
const SEED_ENV = ['ADMIN_SEED_PASSWORD', 'ADMIN_SEED_EMAILS', 'ADMIN_SEED_RESET_PASSWORD']

beforeEach(async () => {
  await resetDb()
  resetThrottle()
  for (const key of SEED_ENV) delete process.env[key]
})

afterEach(() => {
  for (const key of SEED_ENV) delete process.env[key]
})

const asAdmin = (overrides = {}) =>
  createUser({ role: 'ADMIN', ...overrides })

const login = (app, email, password) => request(app).post(LOGIN).send({ email, password })

describe('password hashing', () => {
  test('a hash verifies against its own password and nothing else', async () => {
    const stored = await hashPassword(PASSWORD)
    expect(stored.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword(PASSWORD, stored)).toBe(true)
    expect(await verifyPassword('admin124', stored)).toBe(false)
  })

  test('the same password hashes differently every time', async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD))
  })

  test('a missing or malformed hash is a failed verify, not a throw', async () => {
    expect(await verifyPassword(PASSWORD, null)).toBe(false)
    expect(await verifyPassword(PASSWORD, '')).toBe(false)
    expect(await verifyPassword(PASSWORD, 'not-a-hash')).toBe(false)
    expect(await verifyPassword(PASSWORD, 'scrypt$x$y$z$aaaa$bbbb')).toBe(false)
  })
})

describe('POST /auth/admin/login', () => {
  test('an admin with the right password gets a session cookie', async () => {
    const app = appWith()
    const admin = await asAdmin({
      email: 'admin.one@au.edu',
      name: 'Admin One',
      passwordHash: await hashPassword(PASSWORD),
    })

    const res = await login(app, 'admin.one@au.edu', PASSWORD)
    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({ id: admin.id, role: 'ADMIN' })

    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('aubounty_token='))
    expect(cookie).toBeTruthy()
    expect(cookie).toContain('HttpOnly')

    // The cookie is the whole point: it has to authenticate the next request.
    const me = await request(app).get('/aubounty/api/me').set('Cookie', cookie)
    expect(me.status).toBe(200)
    expect(me.body.user.id).toBe(admin.id)
  })

  test('the address is matched case-insensitively and trimmed', async () => {
    const app = appWith()
    await asAdmin({ email: 'admin.one@au.edu', passwordHash: await hashPassword(PASSWORD) })

    const res = await login(app, '  Admin.One@AU.edu  ', PASSWORD)
    expect(res.status).toBe(200)
  })

  test('the wrong password is refused', async () => {
    const app = appWith()
    await asAdmin({ email: 'admin.one@au.edu', passwordHash: await hashPassword(PASSWORD) })

    const res = await login(app, 'admin.one@au.edu', 'wrong')
    expect(res.status).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  test('a non-admin with a password is refused, and cannot be told apart', async () => {
    const app = appWith()
    await createUser({
      role: 'STUDENT',
      email: 'student.one@au.edu',
      passwordHash: await hashPassword(PASSWORD),
    })

    const wrongRole = await login(app, 'student.one@au.edu', PASSWORD)
    const noSuchUser = await login(app, 'nobody@au.edu', PASSWORD)

    expect(wrongRole.status).toBe(401)
    expect(wrongRole.headers['set-cookie']).toBeUndefined()
    // Identical answers: the form cannot be used to enumerate accounts.
    expect(wrongRole.body).toEqual(noSuchUser.body)
    expect(noSuchUser.status).toBe(401)
  })

  test('an admin with no password set cannot sign in with an empty one', async () => {
    const app = appWith()
    await asAdmin({ email: 'admin.one@au.edu', passwordHash: null })

    expect((await login(app, 'admin.one@au.edu', 'anything')).status).toBe(401)
    expect((await request(app).post(LOGIN).send({ email: 'admin.one@au.edu', password: '' })).status).toBe(400)
  })

  test('a malformed body is a 400, not a 500', async () => {
    const app = appWith()
    expect((await request(app).post(LOGIN).send({})).status).toBe(400)
    expect((await request(app).post(LOGIN).send({ email: 'not-an-email', password: 'x' })).status).toBe(400)
  })

  test('repeated failures are throttled, and a 429 outlasts the right password', async () => {
    const app = appWith()
    await asAdmin({ email: 'admin.one@au.edu', passwordHash: await hashPassword(PASSWORD) })

    for (let i = 0; i < THROTTLE_MAX_FAILURES; i += 1) {
      expect((await login(app, 'admin.one@au.edu', 'wrong')).status).toBe(401)
    }

    const blocked = await login(app, 'admin.one@au.edu', PASSWORD)
    expect(blocked.status).toBe(429)
    expect(blocked.headers['retry-after']).toBeTruthy()
    expect(blocked.headers['set-cookie']).toBeUndefined()
  })

  test('a success clears the failure count', async () => {
    const app = appWith()
    await asAdmin({ email: 'admin.one@au.edu', passwordHash: await hashPassword(PASSWORD) })

    for (let i = 0; i < THROTTLE_MAX_FAILURES - 1; i += 1) {
      await login(app, 'admin.one@au.edu', 'wrong')
    }
    expect((await login(app, 'admin.one@au.edu', PASSWORD)).status).toBe(200)

    // Without the reset, one more miss would trip the limit.
    expect((await login(app, 'admin.one@au.edu', 'wrong')).status).toBe(401)
  })

  test('the cookie carries ADMIN, so the console opens', async () => {
    const app = appWith()
    await asAdmin({ email: 'admin.one@au.edu', passwordHash: await hashPassword(PASSWORD) })

    const res = await login(app, 'admin.one@au.edu', PASSWORD)
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('aubounty_token='))

    const users = await request(app).get('/aubounty/api/admin/users').set('Cookie', cookie)
    expect(users.status).toBe(200)
  })
})

describe('seedAdmins', () => {
  const silent = { log: () => {} }

  test('creates three admin accounts that can sign in with admin123', async () => {
    const app = appWith()
    expect(await seedAdmins(silent)).toMatchObject({ created: 3, updated: 0, unchanged: 0 })

    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, orderBy: { email: 'asc' } })
    expect(admins).toHaveLength(3)
    expect(admins.every((a) => a.passwordHash !== null)).toBe(true)

    for (const { email } of ADMIN_ACCOUNTS) {
      expect((await login(app, email, PASSWORD)).status).toBe(200)
      resetThrottle()
    }
  })

  test('each account gets its own salt', async () => {
    await seedAdmins(silent)
    const hashes = (await prisma.user.findMany({ select: { passwordHash: true } })).map(
      (u) => u.passwordHash,
    )
    expect(new Set(hashes).size).toBe(3)
  })

  test('a second run changes nothing', async () => {
    await seedAdmins(silent)
    const before = await prisma.user.findMany({ orderBy: { email: 'asc' } })

    expect(await seedAdmins(silent)).toMatchObject({ created: 0, updated: 0, unchanged: 3 })

    const after = await prisma.user.findMany({ orderBy: { email: 'asc' } })
    expect(after).toEqual(before)
  })

  test('a password changed after seeding survives the next boot', async () => {
    await seedAdmins(silent)
    const email = ADMIN_ACCOUNTS[0].email
    await prisma.user.update({
      where: { email },
      data: { passwordHash: await hashPassword('a-password-of-their-own') },
    })

    await seedAdmins(silent)

    const app = appWith()
    expect((await login(app, email, 'a-password-of-their-own')).status).toBe(200)
  })

  test('ADMIN_SEED_RESET_PASSWORD=1 puts the seed password back', async () => {
    await seedAdmins(silent)
    const email = ADMIN_ACCOUNTS[0].email
    await prisma.user.update({
      where: { email },
      data: { passwordHash: await hashPassword('a-password-of-their-own') },
    })

    // The switch is deliberately account-wide: it re-hashes all three.
    process.env.ADMIN_SEED_RESET_PASSWORD = '1'
    expect(await seedAdmins(silent)).toMatchObject({ created: 0, updated: 3, unchanged: 0 })

    const app = appWith()
    expect((await login(app, email, PASSWORD)).status).toBe(200)
  })

  test('ADMIN_SEED_PASSWORD and ADMIN_SEED_EMAILS override the defaults', async () => {
    process.env.ADMIN_SEED_PASSWORD = 'something-longer-and-not-guessable'
    process.env.ADMIN_SEED_EMAILS = 'ops@au.edu, second@au.edu'
    await seedAdmins(silent)

    const app = appWith()
    expect((await login(app, 'ops@au.edu', 'something-longer-and-not-guessable')).status).toBe(200)
    // The third address had no override and keeps its default.
    expect(await prisma.user.findUnique({ where: { email: ADMIN_ACCOUNTS[2].email } })).toBeTruthy()
  })

  test('an existing non-admin row at a seeded address is promoted, not duplicated', async () => {
    const email = ADMIN_ACCOUNTS[0].email
    const existing = await createUser({ email, name: 'Already Here', role: 'STUDENT' })

    expect(await seedAdmins(silent)).toMatchObject({ created: 2, updated: 1 })

    const after = await prisma.user.findUnique({ where: { email } })
    expect(after.id).toBe(existing.id)
    expect(after.name).toBe('Already Here')
    expect(after.role).toBe('ADMIN')
    expect(after.passwordHash).not.toBeNull()
  })
})
