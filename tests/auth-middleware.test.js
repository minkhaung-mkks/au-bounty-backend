import { describe, test, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { SignJWT } from 'jose'
import { prisma } from '../src/lib/prisma.js'
import { appWith, createUser, resetDb, sessionCookie } from './helpers.js'

// The cookie middleware is the only auth path exercised here: DEV_AUTH stays
// unset, so nothing but a valid aubounty_token can produce a req.user.
beforeEach(async () => {
  await resetDb()
})

async function tokenFor(payload, { expired = false } = {}) {
  const key = new TextEncoder().encode(process.env.JWT_SECRET)
  let jwt = new SignJWT({ role: payload.role, name: payload.name, orgIds: payload.orgIds ?? [] })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.id)
  if (expired) jwt = jwt.setExpirationTime(-120) // 2 minutes ago
  else jwt = jwt.setExpirationTime('1h')
  return jwt.sign(key)
}

describe('cookie auth middleware', () => {
  test('a valid cookie authenticates without any dev header', async () => {
    const app = appWith({ dev: false })
    const user = await createUser({ name: 'Cookie User', role: 'STUDENT' })

    const res = await request(app)
      .get('/aubounty/api/me')
      .set('Cookie', `aubounty_token=${await tokenFor(user)}`)

    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({ id: user.id, name: 'Cookie User', role: 'STUDENT' })
  })

  test('a missing cookie is unauthenticated', async () => {
    const app = appWith({ dev: false })
    const res = await request(app).get('/aubounty/api/me')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHORIZED')
  })

  test('an expired cookie is unauthenticated', async () => {
    const app = appWith({ dev: false })
    const user = await createUser()

    const res = await request(app)
      .get('/aubounty/api/me')
      .set('Cookie', `aubounty_token=${await tokenFor(user, { expired: true })}`)

    expect(res.status).toBe(401)
  })

  test('a tampered cookie is unauthenticated', async () => {
    const app = appWith({ dev: false })
    const user = await createUser()

    const token = await tokenFor(user)
    // Corrupt the payload segment (middle), which a valid signature can never
    // still cover; unlike the final base64url char, this always changes bytes.
    const [head, payload, sig] = token.split('.')
    const first = payload[0] === 'A' ? 'B' : 'A'
    const tampered = `${head}.${first}${payload.slice(1)}.${sig}`

    const res = await request(app).get('/aubounty/api/me').set('Cookie', `aubounty_token=${tampered}`)
    expect(res.status).toBe(401)
  })

  test('orgIds from the token survive into req.user (isOrgMember flips)', async () => {
    const app = appWith({ dev: false })
    const org = await prisma.organization.create({
      data: { name: `Org ${crypto.randomUUID().slice(0, 8)}` },
    })
    const user = await createUser({ orgIds: [org.id] })

    const res = await request(app)
      .get('/aubounty/api/me')
      .set('Cookie', await sessionCookie(user))

    expect(res.status).toBe(200)
    expect(res.body.orgs.map((o) => o.id)).toEqual([org.id])
  })

  test('with DEV_AUTH=1 a valid cookie wins over a conflicting dev header', async () => {
    const app = appWith({ dev: true })
    const cookieUser = await createUser({ name: 'Cookie User' })
    const headerUser = await createUser({ name: 'Header User' })

    const res = await request(app)
      .get('/aubounty/api/me')
      .set('Cookie', await sessionCookie(cookieUser))
      .set('x-dev-user-id', headerUser.id)

    expect(res.status).toBe(200)
    expect(res.body.user.name).toBe('Cookie User')
  })
})
