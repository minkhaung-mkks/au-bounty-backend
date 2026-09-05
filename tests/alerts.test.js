import { describe, test, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import request from 'supertest'
import { createServer } from 'node:http'
import { prisma } from '../src/lib/prisma.js'
import { appWith, createUser, resetDb } from './helpers.js'
import { sweepAlerts } from '../src/services/alertSweeper.js'
import { startPeerMock } from '../peer-mock/server.js'

const api = '/aubounty/api'
const OUT_KEY = 'outbound-test-key'
const dev = (user) => ({ 'x-dev-user-id': user.id })

const app = appWith({ dev: true })

// One in-process partner mock for the whole file, plus a URL that is
// definitely not listening, for the peer-down path.
let mock
let deadUrl

beforeAll(async () => {
  mock = await startPeerMock({ apiKey: OUT_KEY })
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  deadUrl = `http://127.0.0.1:${port}`
  // Default outbound posture for this file: nothing answers. Individual
  // forwarding tests point at the live mock. Keeps the suite hermetic even
  // when backend/.env names a real PEER_OUTBOUND_URL.
  setEnv('PEER_OUTBOUND_URL', deadUrl)
  setEnv('PEER_OUTBOUND_API_KEY', OUT_KEY)
})

// Peer env is call-time read; restore whatever the process had before tests.
const savedEnv = {}
const setEnv = (name, value) => {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
afterAll(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await mock.close()
})

beforeEach(async () => {
  await resetDb()
  mock.alerts.length = 0
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const until = async (check, ms = 4000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(50)
  }
  return false
}

const flagOf = async (id) => {
  const row = await prisma.emergencyAlert.findUnique({ where: { id } })
  return row?.forwardedToPeer
}

const press = (user, body = { lat: 13.61, lng: 100.71 }) =>
  request(app).post(`${api}/alerts`).set(dev(user)).send(body)

describe('POST /alerts', () => {
  test('a fresh user presses successfully', async () => {
    const user = await createUser({ name: 'Presser', universityId: '6700001' })
    const res = await press(user, { lat: 13.6122, lng: 100.8368, message: 'fell on the stairs' })
    expect(res.status).toBe(201)
    expect(res.body.alert).toMatchObject({
      lat: 13.6122,
      lng: 100.8368,
      message: 'fell on the stairs',
      status: 'ACTIVE',
      forwardedToPeer: false,
      resolvedAt: null,
    })
    expect(res.body.alert.id).toEqual(expect.any(String))
    expect(res.body.alert.createdAt).toEqual(expect.any(String))
  })

  test('an immediate second press is 409 with retryAfterSeconds and activeAlertId', async () => {
    const user = await createUser()
    expect((await press(user)).status).toBe(201)

    const again = await press(user)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('ALERT_COOLDOWN')
    expect(again.body.error.details.retryAfterSeconds).toBeGreaterThan(0)
    expect(again.body.error.details.retryAfterSeconds).toBeLessThanOrEqual(300)
    expect(again.body.error.details.activeAlertId).toEqual(
      (await prisma.emergencyAlert.findFirst({ where: { userId: user.id } })).id,
    )
  })

  test('a press after the alert was resolved still hits the cooldown, without activeAlertId', async () => {
    const user = await createUser()
    expect((await press(user)).status).toBe(201)
    await prisma.emergencyAlert.updateMany({
      where: { userId: user.id },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    })

    const again = await press(user)
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('ALERT_COOLDOWN')
    expect(again.body.error.details.retryAfterSeconds).toBeGreaterThan(0)
    expect(again.body.error.details).not.toHaveProperty('activeAlertId')
  })

  test('once the cooldown has passed a new alert can be pressed', async () => {
    const user = await createUser()
    expect((await press(user)).status).toBe(201)
    // Resolve it and pretend it was pressed 6 minutes ago (cooldown is 5).
    await prisma.emergencyAlert.updateMany({
      where: { userId: user.id },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date(),
        createdAt: new Date(Date.now() - 6 * 60_000),
      },
    })

    const next = await press(user, { lat: 1, lng: 2 })
    expect(next.status).toBe(201)
    expect(await prisma.emergencyAlert.count({ where: { userId: user.id } })).toBe(2)
  })

  test('an unauthenticated press is 401 and a bad body is 400', async () => {
    expect((await request(app).post(`${api}/alerts`).send({ lat: 1, lng: 2 })).status).toBe(401)
    const user = await createUser()
    expect((await press(user, { lat: 999, lng: 2 })).status).toBe(400)
    expect((await press(user, { lat: 1 })).status).toBe(400)
  })
})

describe('GET /me/alerts', () => {
  test('returns own history newest first', async () => {
    const user = await createUser()
    const mine = await prisma.emergencyAlert.createMany({
      data: [
        { userId: user.id, lat: 1, lng: 2, createdAt: new Date(Date.now() - 60_000) },
        { userId: user.id, lat: 3, lng: 4, message: 'newest', status: 'RESOLVED', resolvedAt: new Date() },
      ],
    })
    expect(mine.count).toBe(2)

    const res = await request(app).get(`${api}/me/alerts`).set(dev(user))
    expect(res.status).toBe(200)
    expect(res.body.alerts).toHaveLength(2)
    expect(res.body.alerts[0].message).toBe('newest')
    expect(res.body.alerts[1].lat).toBe(1)
    expect(res.body.alerts[0]).toMatchObject({
      status: 'RESOLVED',
      forwardedToPeer: false,
      resolvedAt: expect.any(String),
    })

    const other = await createUser()
    expect((await request(app).get(`${api}/me/alerts`).set(dev(other))).body.alerts).toHaveLength(0)
  })
})

describe('peer forwarding', () => {
  test('a 2xx from the partner flips forwardedToPeer on the stored row', async () => {
    setEnv('PEER_OUTBOUND_URL', mock.url)
    setEnv('PEER_OUTBOUND_API_KEY', OUT_KEY)
    const user = await createUser({ name: 'Forwarded Student', universityId: '6701234' })

    const res = await press(user, { lat: 13.6, lng: 100.7, message: 'stuck in lift' })
    expect(res.status).toBe(201)
    expect(await until(async () => (await flagOf(res.body.alert.id)) === true)).toBe(true)

    const listed = await fetch(`${mock.url}/api/peer/emergency-alerts`, {
      headers: { 'x-api-key': OUT_KEY },
    }).then((r) => r.json())
    expect(listed.alerts[0]).toMatchObject({
      universityId: '6701234',
      name: 'Forwarded Student',
      email: user.email,
      lat: 13.6,
      lng: 100.7,
      message: 'stuck in lift',
    })
    expect(listed.alerts[0].pressedAt).toEqual(expect.any(String))
  })

  test('a wrong outbound key never flips the flag', async () => {
    setEnv('PEER_OUTBOUND_URL', mock.url)
    setEnv('PEER_OUTBOUND_API_KEY', 'the-wrong-key')
    const user = await createUser()

    const res = await press(user)
    expect(res.status).toBe(201)
    await sleep(300) // the mock answers 401; give the attempt time to land
    const seen = await fetch(`${mock.url}/api/peer/emergency-alerts`, {
      headers: { 'x-api-key': OUT_KEY },
    }).then((r) => r.json())
    expect(seen.alerts).toHaveLength(0)
    expect(await flagOf(res.body.alert.id)).toBe(false)
  })

  test('a dead partner leaves the flag false, and a sweeper pass flips it once it is back', async () => {
    setEnv('PEER_OUTBOUND_URL', deadUrl)
    setEnv('PEER_OUTBOUND_API_KEY', OUT_KEY)
    const user = await createUser()

    const res = await press(user)
    expect(res.status).toBe(201)
    await sleep(300) // let the failed immediate attempt land
    expect(await flagOf(res.body.alert.id)).toBe(false)

    setEnv('PEER_OUTBOUND_URL', mock.url)
    expect(await sweepAlerts()).toBeGreaterThanOrEqual(1)
    expect(await flagOf(res.body.alert.id)).toBe(true)
  })
})
