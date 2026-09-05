import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createServer } from 'node:http'
import { io as client } from 'socket.io-client'
import { prisma } from '../src/lib/prisma.js'
import { appWith, createUser, resetDb, sessionCookie } from './helpers.js'
import { attachSockets } from '../src/realtime/gateway.js'
import { resetIo } from '../src/realtime/io.js'

const api = '/aubounty/api'

// One express app on an ephemeral port, with the socket gateway attached to
// the same HTTP server, exactly like src/index.js wires production.
const app = appWith({ dev: true })
const server = createServer(app)

beforeAll(async () => {
  attachSockets(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterAll(async () => {
  resetIo()
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(async () => {
  await resetDb()
})

const sockets = new Set()
afterEach(async () => {
  await Promise.allSettled([...sockets].map((s) => s.disconnect()))
  sockets.clear()
})

const url = () => `http://127.0.0.1:${server.address().port}`
const opts = { path: '/aubounty/socket.io', transports: ['websocket'] }

function connect(extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const sock = client(url(), { ...opts, extraHeaders })
    sockets.add(sock)
    sock.once('connect', () => resolve(sock))
    sock.once('connect_error', (err) => reject(err))
  })
}

const cookieConnect = async (user) => connect({ Cookie: await sessionCookie(user) })

function connectFails(extraHeaders = {}) {
  return new Promise((resolve) => {
    const sock = client(url(), { ...opts, extraHeaders })
    sockets.add(sock)
    sock.once('connect_error', (err) => resolve(err.message))
  })
}

const nextEvent = (sock, event, ms = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms)
    sock.once(event, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })

const ack = (sock, event, payload) =>
  new Promise((resolve) => sock.emit(event, payload, resolve))

const dev = (user) => ({ 'x-dev-user-id': user.id })

async function seedThread() {
  const tag = await prisma.tag.create({
    data: { name: `tag-${crypto.randomUUID()}`, category: 'ERRAND' },
  })
  const poster = await createUser({ name: 'Poster' })
  const taker = await createUser({ name: 'Taker' })
  const outsider = await createUser({ name: 'Outsider' })
  const task = await prisma.task.create({
    data: {
      title: 'Fix my bike',
      content: 'Chain keeps slipping',
      type: 'REQUEST',
      posterId: poster.id,
      locationName: 'Bike rack',
      tags: { create: [{ tagId: tag.id }] },
    },
  })
  const assignment = await prisma.taskAssignment.create({
    data: { taskId: task.id, takerId: taker.id, status: 'ACCEPTED' },
  })
  return { poster, taker, outsider, task, assignment, tag }
}

/* -------------------------------------------------------------------------- */

describe('gateway authentication', () => {
  test('rejects a socket with no credentials', async () => {
    expect(await connectFails()).toBe('unauthorized')
  })

  test('rejects an unknown dev header even with DEV_AUTH=1', async () => {
    expect(
      await connectFails({ 'x-dev-user-id': '00000000-0000-0000-0000-000000000000' }),
    ).toBe('unauthorized')
  })

  test('accepts the dev header when DEV_AUTH=1 (parity with REST)', async () => {
    const user = await createUser()
    const sock = await connect(dev(user))
    expect(sock.connected).toBe(true)
  })

  test('accepts a valid session cookie', async () => {
    const user = await createUser()
    const sock = await cookieConnect(user)
    expect(sock.connected).toBe(true)
  })
})

describe('subscribe', () => {
  test('any authenticated user may join a task room', async () => {
    const { task } = await seedThread()
    const user = await createUser()
    const sock = await cookieConnect(user)

    expect(await ack(sock, 'subscribe', { taskId: task.id })).toEqual({
      ok: true,
      room: `task:${task.id}`,
    })
    expect(await ack(sock, 'unsubscribe', { taskId: task.id })).toEqual({
      ok: true,
      room: `task:${task.id}`,
    })
  })

  test('an assignment room is participants-only', async () => {
    const { poster, taker, outsider, assignment } = await seedThread()
    const sock = await cookieConnect(outsider)

    expect(await ack(sock, 'subscribe', { assignmentId: assignment.id })).toEqual({
      ok: false,
      error: 'forbidden',
    })

    const posterSock = await cookieConnect(poster)
    expect(await ack(posterSock, 'subscribe', { assignmentId: assignment.id })).toEqual({
      ok: true,
      room: `assignment:${assignment.id}`,
    })

    const takerSock = await connect(dev(taker))
    expect(await ack(takerSock, 'subscribe', { assignmentId: assignment.id })).toEqual({
      ok: true,
      room: `assignment:${assignment.id}`,
    })
  })

  test('garbage and unknown ids fail cleanly', async () => {
    const sock = await cookieConnect(await createUser())
    expect(await ack(sock, 'subscribe', {})).toEqual({ ok: false, error: 'bad_request' })
    expect(await ack(sock, 'subscribe', { taskId: 'nope' })).toEqual({
      ok: false,
      error: 'bad_request',
    })
    expect(await ack(sock, 'subscribe', { taskId: crypto.randomUUID() })).toEqual({
      ok: false,
      error: 'not_found',
    })
    expect(
      await ack(sock, 'subscribe', { assignmentId: crypto.randomUUID() }),
    ).toEqual({ ok: false, error: 'not_found' })
  })
})

describe('message fan-out', () => {
  test('message:new reaches the thread room and nudges the counterpart', async () => {
    const { poster, taker, assignment } = await seedThread()

    const inRoom = await cookieConnect(taker)
    expect((await ack(inRoom, 'subscribe', { assignmentId: assignment.id })).ok).toBe(true)

    const idle = await cookieConnect(taker) // subscribed to nothing: user room only

    const roomEvent = nextEvent(inRoom, 'message:new')
    const nudgeEvent = nextEvent(idle, 'message:new')

    const posted = await request(app)
      .post(`${api}/assignments/${assignment.id}/messages`)
      .set(dev(poster))
      .send({ content: 'picked up the parts' })
    expect(posted.status).toBe(201)

    await expect(roomEvent).resolves.toMatchObject({
      message: {
        assignmentId: assignment.id,
        senderId: poster.id,
        content: 'picked up the parts',
        readAt: null,
      },
    })
    // The personal-room nudge is deliberately lightweight: just the id.
    await expect(nudgeEvent).resolves.toEqual({ assignmentId: assignment.id })
  })

  test('message:read announces how far the reader got', async () => {
    const { poster, taker, assignment } = await seedThread()
    await request(app)
      .post(`${api}/assignments/${assignment.id}/messages`)
      .set(dev(poster))
      .send({ content: 'status?' })

    const sock = await cookieConnect(poster)
    expect((await ack(sock, 'subscribe', { assignmentId: assignment.id })).ok).toBe(true)

    const readEvent = nextEvent(sock, 'message:read')
    const read = await request(app)
      .post(`${api}/assignments/${assignment.id}/read`)
      .set(dev(taker))
    expect(read.status).toBe(204)

    const [only] = await prisma.message.findMany({ where: { assignmentId: assignment.id } })
    await expect(readEvent).resolves.toEqual({
      assignmentId: assignment.id,
      readerId: taker.id,
      untilMessageId: only.id,
    })
  })
})

describe('task and emergency fan-out', () => {
  test('emergency:new reaches a connected client when an EMERGENCY task is posted', async () => {
    const { poster, tag } = await seedThread()
    const sock = await cookieConnect(poster)
    const event = nextEvent(sock, 'emergency:new')

    const created = await request(app)
      .post(`${api}/tasks`)
      .set(dev(poster))
      .send({
        title: 'Lost inhaler',
        content: 'Medication lost near the canteen',
        type: 'EMERGENCY',
        locationName: 'Canteen',
        maxTakers: 1,
        tagIds: [tag.id],
      })
    expect(created.status).toBe(201)

    await expect(event).resolves.toEqual({
      taskId: created.body.task.id,
      title: 'Lost inhaler',
      locationName: 'Canteen',
      createdAt: created.body.task.createdAt,
    })
  })

  test('task:updated fires on apply with fresh occupancy', async () => {
    const { poster, taker, tag } = await seedThread()
    const created = await request(app)
      .post(`${api}/tasks`)
      .set(dev(poster))
      .send({
        title: 'Weekend moving help',
        content: 'Two hours of lifting',
        type: 'REQUEST',
        acceptanceMode: 'AUTO',
        maxTakers: 2,
        locationName: 'Dorm A',
        tagIds: [tag.id],
      })
    const taskId = created.body.task.id

    const sock = await cookieConnect(taker)
    expect((await ack(sock, 'subscribe', { taskId })).ok).toBe(true)

    const event = nextEvent(sock, 'task:updated')
    const applied = await request(app).post(`${api}/tasks/${taskId}/apply`).set(dev(taker))
    expect(applied.status).toBe(201)

    await expect(event).resolves.toEqual({
      taskId,
      status: 'OPEN',
      takenCount: 1,
      spotsLeft: 1,
    })
  })

  test('task:updated fires on the settle engine auto-confirming a completion', async () => {
    const { poster, taker, tag } = await seedThread()
    const created = await request(app)
      .post(`${api}/tasks`)
      .set(dev(poster))
      .send({
        title: 'Scan lecture notes',
        content: 'Forty pages',
        type: 'REQUEST',
        acceptanceMode: 'AUTO',
        maxTakers: 1,
        locationName: 'Library',
        tagIds: [tag.id],
      })
    const taskId = created.body.task.id
    expect((await request(app).post(`${api}/tasks/${taskId}/apply`).set(dev(taker))).status).toBe(201)
    const assignmentRow = await prisma.taskAssignment.findFirst({ where: { taskId } })
    expect(
      (
        await request(app)
          .post(`${api}/assignments/${assignmentRow.id}/complete`)
          .set(dev(taker))
      ).status,
    ).toBe(200)

    // Pretend the 7-day confirmation window lapsed while nobody was looking.
    await prisma.taskAssignment.update({
      where: { id: assignmentRow.id },
      data: { completionRequestedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    })

    const sock = await cookieConnect(poster)
    expect((await ack(sock, 'subscribe', { taskId })).ok).toBe(true)

    const event = nextEvent(sock, 'task:updated')
    // Any authenticated request drives settle() before the route runs.
    expect((await request(app).get(`${api}/tasks`).set(dev(poster))).status).toBe(200)

    await expect(event).resolves.toEqual({
      taskId,
      status: 'COMPLETED',
      takenCount: 1,
      spotsLeft: 0,
    })
  })
})
