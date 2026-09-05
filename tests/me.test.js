import { describe, test, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/lib/prisma.js'
import { appWith, createUser, resetDb, sessionCookie } from './helpers.js'

beforeEach(async () => {
  await resetDb()
})

describe('PUT /me', () => {
  test('bio is editable (and clearable) without touching universityId', async () => {
    const app = appWith()
    const user = await createUser({ bio: null, universityId: null })

    const first = await request(app)
      .put('/aubounty/api/me')
      .set('Cookie', await sessionCookie(user))
      .send({ bio: 'I fix printers.' })
    expect(first.status).toBe(200)
    expect(first.body.user.bio).toBe('I fix printers.')
    expect(first.body.user.universityId).toBeNull()

    const second = await request(app)
      .put('/aubounty/api/me')
      .set('Cookie', await sessionCookie(user))
      .send({ bio: null })
    expect(second.status).toBe(200)
    expect(second.body.user.bio).toBeNull()
  })

  test('universityId is settable exactly once', async () => {
    const app = appWith()
    const user = await createUser({ universityId: null })
    const cookie = await sessionCookie(user)

    const set = await request(app).put('/aubounty/api/me').set('Cookie', cookie).send({ universityId: '6709999' })
    expect(set.status).toBe(200)
    expect(set.body.user.universityId).toBe('6709999')

    // Same value again is idempotent, not a conflict.
    const again = await request(app).put('/aubounty/api/me').set('Cookie', cookie).send({ universityId: '6709999' })
    expect(again.status).toBe(200)

    // A different value is refused.
    const change = await request(app)
      .put('/aubounty/api/me')
      .set('Cookie', cookie)
      .send({ universityId: '6708888' })
    expect(change.status).toBe(409)
    expect(change.body.error.code).toBe('CONFLICT')
  })

  test('a universityId that already belongs to someone else maps to 409', async () => {
    const app = appWith()
    const user = await createUser({ universityId: null })
    await createUser({ universityId: '6707777' })

    const res = await request(app)
      .put('/aubounty/api/me')
      .set('Cookie', await sessionCookie(user))
      .send({ universityId: '6707777' })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT')
  })

  test('rejects invalid bodies and unauthenticated calls', async () => {
    const app = appWith()
    const user = await createUser({ universityId: null })
    const cookie = await sessionCookie(user)

    const short = await request(app).put('/aubounty/api/me').set('Cookie', cookie).send({ universityId: 'ab' })
    expect(short.status).toBe(400)

    const anon = await request(app).put('/aubounty/api/me').send({ bio: 'x' })
    expect(anon.status).toBe(401)
  })

  test('works through the dev header path too', async () => {
    const app = appWith({ dev: true })
    const user = await createUser({ universityId: null })

    const res = await request(app)
      .put('/aubounty/api/me')
      .set('x-dev-user-id', user.id)
      .send({ bio: 'dev path', universityId: '6701234' })

    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({ bio: 'dev path', universityId: '6701234' })
  })
})

describe('GET /me', () => {
  test('still serves the full profile shape under cookie auth', async () => {
    const app = appWith({ dev: false })
    const user = await createUser({ name: 'Profile Check', bio: 'hello', universityId: '6705555' })

    const res = await request(app)
      .get('/aubounty/api/me')
      .set('Cookie', await sessionCookie(user))

    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({
      id: user.id,
      name: 'Profile Check',
      email: user.email,
      bio: 'hello',
      universityId: '6705555',
    })
    expect(res.body).toHaveProperty('orgs')
    expect(res.body).toHaveProperty('tags')
    expect(res.body).toHaveProperty('stats')
  })

  test('a session pointing at a deleted user is unauthorized, not a crash', async () => {
    const app = appWith({ dev: false })
    const user = await createUser()
    const cookie = await sessionCookie(user)
    await prisma.user.delete({ where: { id: user.id } })

    const res = await request(app).get('/aubounty/api/me').set('Cookie', cookie)
    expect(res.status).toBe(401)
  })
})
