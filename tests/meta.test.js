import { describe, test, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { appWith, resetDb } from './helpers.js'

// /dev/users lists whatever is in the User table, so this file cannot depend
// on which file vitest happened to schedule before it.
beforeEach(async () => {
  await resetDb()
})

describe('GET /meta', () => {
  test('reports the dev picker and an unconfigured entra block', async () => {
    delete process.env.GOOGLE_MAPS_KEY
    delete process.env.GOOGLE_TRANSLATE_KEY
    const app = appWith({ dev: true, entraSecret: '' })
    const res = await request(app).get('/aubounty/api/meta')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      devAuth: true,
      auth: { provider: 'microsoft', configured: false },
      capabilities: { maps: false, translation: false, weather: true, files: true },
    })
  })

  test('flips with the environment', async () => {
    process.env.GOOGLE_MAPS_KEY = 'maps-test-key'
    process.env.GOOGLE_TRANSLATE_KEY = 'translate-test-key'
    const app = appWith({ dev: false, entraSecret: 'secret-value' })
    const res = await request(app).get('/aubounty/api/meta')
    expect(res.body).toEqual({
      devAuth: false,
      auth: { provider: 'microsoft', configured: true },
      capabilities: { maps: true, translation: true, weather: true, files: true },
    })
    delete process.env.GOOGLE_MAPS_KEY
    delete process.env.GOOGLE_TRANSLATE_KEY
  })
})

describe('dev surface gating', () => {
  test('with DEV_AUTH=1 the /dev routes exist', async () => {
    const app = appWith({ dev: true })
    const res = await request(app).get('/aubounty/api/dev/users')
    expect(res.status).toBe(200)
    expect(res.body.users).toEqual([])
  })

  test('with DEV_AUTH unset the /dev routes 404 and cookie auth is the only path', async () => {
    const app = appWith({ dev: false })
    expect((await request(app).get('/aubounty/api/dev/users')).status).toBe(404)
    expect((await request(app).post('/aubounty/api/dev/advance-clock')).status).toBe(404)
    // And the dev header no longer resolves anyone.
    const res = await request(app)
      .get('/aubounty/api/me')
      .set('x-dev-user-id', '00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(401)
  })
})
