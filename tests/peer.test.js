import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createServer } from 'node:http'
import { io as client } from 'socket.io-client'
import { prisma } from '../src/lib/prisma.js'
import { appWith, createUser, resetDb, sessionCookie } from './helpers.js'
import { attachSockets } from '../src/realtime/gateway.js'
import { resetIo } from '../src/realtime/io.js'

const api = '/aubounty/api'
const IN_KEY = 'inbound-test-key'

// Like sockets.test.js: one app on an ephemeral port with the gateway attached,
// so emergency:new fan-out can be asserted over a real socket.
const app = appWith({ dev: true })
const server = createServer(app)

const savedInboundKey = process.env.PEER_INBOUND_API_KEY

beforeAll(async () => {
  process.env.PEER_INBOUND_API_KEY = IN_KEY
  attachSockets(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterAll(async () => {
  if (savedInboundKey === undefined) delete process.env.PEER_INBOUND_API_KEY
  else process.env.PEER_INBOUND_API_KEY = savedInboundKey
  resetIo()
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(async () => {
  process.env.PEER_INBOUND_API_KEY = IN_KEY
  await resetDb()
})

const sockets = new Set()
afterEach(async () => {
  await Promise.allSettled([...sockets].map((s) => s.disconnect()))
  sockets.clear()
})

const post = (body, key = IN_KEY) =>
  request(app)
    .post(`${api}/peer/emergency-tasks`)
    .set(key === null ? {} : { 'x-api-key': key })
    .send(body)

const validBody = {
  externalRef: 'sl-systems-alert-0001',
  title: 'Student needs first aid',
  content: 'A student collapsed near the sports complex field.',
  locationName: 'Sports complex',
  locationLat: 13.6105,
  locationLng: 100.7141,
}

describe('POST /peer/emergency-tasks auth', () => {
  test('no key is 401', async () => {
    const res = await post(validBody, null)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHORIZED')
    expect(await prisma.task.count()).toBe(0)
  })

  test('an incorrect key is 401', async () => {
    expect((await post(validBody, 'not-the-key')).status).toBe(401)
    expect(await prisma.task.count()).toBe(0)
  })

  test('an unset key is 503 and writes nothing', async () => {
    delete process.env.PEER_INBOUND_API_KEY
    const res = await post(validBody)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('PEER_API_UNCONFIGURED')
    expect(await prisma.task.count()).toBe(0)
  })

  test('with no SERVICE account seeded the endpoint is 503', async () => {
    const res = await post(validBody)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('SERVICE_USER_MISSING')
  })
})

describe('POST /peer/emergency-tasks', () => {
  test('creates the exact EMERGENCY task shape owned by the SERVICE user', async () => {
    const service = await createUser({ name: 'Partner Alert System', role: 'SERVICE' })

    const res = await post({
      ...validBody,
      rewardDescription: 'Campus clinic voucher',
      maxTakers: 12,
    })
    expect(res.status).toBe(201)
    expect(res.body.task).toMatchObject({
      title: 'Student needs first aid',
      content: validBody.content,
      type: 'EMERGENCY',
      status: 'OPEN',
      acceptanceMode: 'AUTO',
      externalRef: 'sl-systems-alert-0001',
      maxTakers: 12,
      reward: { type: 'OTHER', description: 'Campus clinic voucher' },
      location: { name: 'Sports complex', lat: 13.6105, lng: 100.7141 },
      poster: { id: service.id, name: 'Partner Alert System', role: 'SERVICE', universityId: null },
      org: null,
      tags: [],
      isMine: false,
      myAssignment: null,
      takenCount: 0,
      spotsLeft: 12,
    })

    // The defaults a bare partner push gets.
    const bare = await post({
      externalRef: 'sl-systems-alert-0002',
      title: 'Fire alarm',
      content: 'Evacuation support needed at Building C.',
    })
    expect(bare.status).toBe(201)
    expect(bare.body.task).toMatchObject({
      maxTakers: 5,
      reward: { type: 'NONE', description: '' },
      location: { name: null, lat: null, lng: null },
    })
  })

  test('a duplicate externalRef is 409 with existingTaskId and creates nothing new', async () => {
    await createUser({ role: 'SERVICE' })
    const first = await post(validBody)
    expect(first.status).toBe(201)

    const dupe = await post({ ...validBody, title: 'Partner retried the same alert' })
    expect(dupe.status).toBe(409)
    expect(dupe.body.error.code).toBe('DUPLICATE_EXTERNAL_REF')
    expect(dupe.body.error.details.existingTaskId).toBe(first.body.task.id)
    expect(await prisma.task.count()).toBe(1)
  })

  test('rejects malformed bodies with 400', async () => {
    await createUser({ role: 'SERVICE' })
    const cases = [
      { ...validBody, externalRef: '' },
      { ...validBody, externalRef: 'x'.repeat(201) },
      { ...validBody, title: '' },
      { ...validBody, content: 'x'.repeat(5001) },
      { ...validBody, maxTakers: 51 },
      { ...validBody, maxTakers: 1.5 },
      { ...validBody, locationLat: 91 },
      { ...validBody, title: 42 },
      { title: 'missing the externalRef' },
      {},
    ]
    for (const body of cases) expect((await post(body)).status).toBe(400)
    expect(await prisma.task.count()).toBe(0)
  })
})

describe('emergency:new fan-out from the peer route', () => {
  test('an inbound partner alert reaches the emergencies room', async () => {
    await createUser({ role: 'SERVICE' })
    const watcher = await createUser()
    const cookie = await sessionCookie(watcher)
    const sock = await new Promise((resolve, reject) => {
      const s = client(`http://127.0.0.1:${server.address().port}`, {
        path: '/aubounty/socket.io',
        transports: ['websocket'],
        extraHeaders: { Cookie: cookie },
      })
      sockets.add(s)
      s.once('connect', () => resolve(s))
      s.once('connect_error', reject)
    })

    const event = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for emergency:new')), 5000)
      sock.once('emergency:new', (payload) => {
        clearTimeout(timer)
        resolve(payload)
      })
    })

    const created = await post(validBody)
    expect(created.status).toBe(201)
    await expect(event).resolves.toEqual({
      taskId: created.body.task.id,
      title: 'Student needs first aid',
      locationName: 'Sports complex',
      createdAt: created.body.task.createdAt,
    })
  })
})
