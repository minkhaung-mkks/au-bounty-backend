import { describe, test, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { appWith, createUser, resetDb } from './helpers.js'

// Regression guard: the board still answers under the dev flow exactly as it
// did before real auth landed.
beforeEach(async () => {
  await resetDb()
})

describe('existing behavior smoke (DEV_AUTH=1)', () => {
  test('GET /tasks answers through the dev header', async () => {
    const app = appWith({ dev: true })
    const user = await createUser({ name: 'Smoke User' })

    const res = await request(app).get('/aubounty/api/tasks').set('x-dev-user-id', user.id)

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('tasks')
    expect(Array.isArray(res.body.tasks)).toBe(true)
  })

  test('health and unauthenticated reads keep working', async () => {
    const app = appWith({ dev: true })
    expect((await request(app).get('/aubounty/api/health')).status).toBe(200)
    expect((await request(app).get('/aubounty/api/tasks')).status).toBe(200)
  })
})
