import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createServer } from 'node:http'
import { io as client } from 'socket.io-client'
import { prisma } from '../src/lib/prisma.js'
import { appWith, createUser, resetDb } from './helpers.js'
import { attachSockets } from '../src/realtime/gateway.js'
import { resetIo } from '../src/realtime/io.js'
import { codeAt, currentCode, stepIndex } from '../src/lib/totp.js'

const api = '/aubounty/api'
const dev = (user) => ({ 'x-dev-user-id': user.id })

// One app with the socket gateway attached, exactly like production wiring.
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
const connect = async (user) => {
  const sock = client(url(), {
    path: '/aubounty/socket.io',
    transports: ['websocket'],
    extraHeaders: dev(user),
  })
  sockets.add(sock)
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve)
    sock.once('connect_error', reject)
  })
  return sock
}

/** An EVENT task with a known secret, its organizer, an RSVPed student. */
async function seedEvent({
  secret = 'SEEDSECRETA',
  acceptanceMode = 'AUTO',
  maxTakers = 10,
  orgSponsored = true,
  posterRole = 'STUDENT',
} = {}) {
  const tag = await prisma.tag.create({
    data: { name: `tag-${crypto.randomUUID()}`, category: 'ERRAND' },
  })
  const org = orgSponsored
    ? await prisma.organization.create({ data: { name: `Org ${crypto.randomUUID().slice(0, 8)}` } })
    : null
  const organizer = await createUser({
    name: 'Organizer',
    role: posterRole,
    orgIds: org ? [org.id] : [],
  })
  const event = await prisma.task.create({
    data: {
      title: 'AI Keynote',
      content: 'Talk, Q&A, pizza',
      type: 'EVENT',
      posterId: organizer.id,
      orgId: org?.id ?? null,
      acceptanceMode,
      maxTakers,
      locationName: 'Auditorium',
      startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      deadline: new Date(Date.now() + 25 * 60 * 60 * 1000),
      checkinSecret: secret,
      tags: { create: [{ tagId: tag.id }] },
    },
  })
  const student = await createUser({ name: 'Attendee' })
  return { tag, org, organizer, event, student }
}

const rsvp = async (event, user) =>
  prisma.taskAssignment.create({
    data: { taskId: event.id, takerId: user.id, status: 'ACCEPTED' },
  })

/* ------------------------------------------------------- GET checkin-code */

describe('GET /tasks/:id/checkin-code access', () => {
  test('the event poster gets the rotating code and its lifetime', async () => {
    const { event, organizer } = await seedEvent()
    const before = currentCode('SEEDSECRETA')
    const res = await request(app).get(`${api}/tasks/${event.id}/checkin-code`).set(dev(organizer))
    // A step boundary may have crossed mid-request, so either neighbor is fine.
    const after = currentCode('SEEDSECRETA')

    expect(res.status).toBe(200)
    expect(res.body.code).toMatch(/^\d{6}$/)
    expect([before, after]).toContain(res.body.code)
    expect(res.body.periodSeconds).toBe(60)
    expect(res.body.remainingSeconds).toBeGreaterThanOrEqual(1)
    expect(res.body.remainingSeconds).toBeLessThanOrEqual(60)
  })

  test('a member of the sponsoring org may show the code', async () => {
    const { event, org } = await seedEvent()
    const member = await createUser({ name: 'Fellow Org Member', orgIds: [org.id] })
    expect((await request(app).get(`${api}/tasks/${event.id}/checkin-code`).set(dev(member))).status).toBe(200)
  })

  test('a teacher sees the code only on their own events; admins see any', async () => {
    const { event } = await seedEvent()
    const otherTeacher = await createUser({ name: 'Other Teacher', role: 'TEACHER' })
    const admin = await createUser({ name: 'Admin', role: 'ADMIN' })
    expect((await request(app).get(`${api}/tasks/${event.id}/checkin-code`).set(dev(otherTeacher))).status).toBe(403)
    // ...and no roster for them either.
    expect((await request(app).get(`${api}/tasks/${event.id}`).set(dev(otherTeacher))).body.task.assignments).toBeUndefined()
    expect((await request(app).get(`${api}/tasks/${event.id}/checkin-code`).set(dev(admin))).status).toBe(200)

    const own = await seedEvent({ orgSponsored: false, posterRole: 'TEACHER' })
    expect((await request(app).get(`${api}/tasks/${own.event.id}/checkin-code`).set(dev(own.organizer))).status).toBe(200)
  })

  test('a student outside the sponsoring org is refused', async () => {
    const { event } = await seedEvent()
    const outsider = await createUser({ name: 'Unrelated Student' })
    const res = await request(app).get(`${api}/tasks/${event.id}/checkin-code`).set(dev(outsider))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  test('an org member of a different org is refused', async () => {
    const { event } = await seedEvent()
    const otherOrg = await prisma.organization.create({ data: { name: `Other ${crypto.randomUUID().slice(0, 8)}` } })
    const member = await createUser({ name: 'Other Org', orgIds: [otherOrg.id] })
    expect((await request(app).get(`${api}/tasks/${event.id}/checkin-code`).set(dev(member))).status).toBe(403)
  })

  test('non-events and unknown ids are 404, anonymous is 401', async () => {
    const { organizer } = await seedEvent()
    const tag = await prisma.tag.create({ data: { name: `t-${crypto.randomUUID()}`, category: 'ERRAND' } })
    const requestTask = await prisma.task.create({
      data: {
        title: 'Fix my bike',
        content: 'Chain slipped',
        type: 'REQUEST',
        posterId: organizer.id,
        tags: { create: [{ tagId: tag.id }] },
      },
    })
    expect((await request(app).get(`${api}/tasks/${requestTask.id}/checkin-code`).set(dev(organizer))).status).toBe(404)
    expect(
      (await request(app).get(`${api}/tasks/${crypto.randomUUID()}/checkin-code`).set(dev(organizer))).status,
    ).toBe(404)
    expect((await request(app).get(`${api}/tasks/${crypto.randomUUID()}/checkin-code`)).status).toBe(401)
  })
})

/* ---------------------------------------------------------- POST checkin */

describe('POST /tasks/:id/checkin', () => {
  test('a current code completes the RSVP and records who checked in', async () => {
    const { event, student } = await seedEvent()
    await rsvp(event, student)

    const res = await request(app)
      .post(`${api}/tasks/${event.id}/checkin`)
      .set(dev(student))
      .send({ code: currentCode('SEEDSECRETA') })

    expect(res.status).toBe(200)
    expect(res.body.assignment.status).toBe('COMPLETED')
    expect(res.body.assignment.checkedInBy).toBe(student.id)
    expect(res.body.assignment.checkedInAt).toBeTruthy()
    expect(res.body.assignment.completedAt).toBeTruthy()

    const row = await prisma.taskAssignment.findFirst({ where: { taskId: event.id } })
    expect(row.status).toBe('COMPLETED')
    expect(row.checkedInBy).toBe(student.id)
  })

  test('the organizer roster shows the check-in stamps, outsiders do not see them', async () => {
    const { event, organizer, student } = await seedEvent()
    await rsvp(event, student)
    await request(app)
      .post(`${api}/tasks/${event.id}/checkin`)
      .set(dev(student))
      .send({ code: currentCode('SEEDSECRETA') })

    const roster = await request(app).get(`${api}/tasks/${event.id}`).set(dev(organizer))
    expect(roster.body.task.assignments).toHaveLength(1)
    expect(roster.body.task.assignments[0].checkedInBy).toBe(student.id)
    expect(roster.body.task.assignments[0].checkedInAt).toBeTruthy()

    const outsider = await createUser({ name: 'Nope' })
    const view = await request(app).get(`${api}/tasks/${event.id}`).set(dev(outsider))
    expect(view.body.task.assignments).toBeUndefined()
  })

  test('checking in twice is a 409', async () => {
    const { event, student } = await seedEvent()
    await rsvp(event, student)
    const code = currentCode('SEEDSECRETA')
    expect((await request(app).post(`${api}/tasks/${event.id}/checkin`).set(dev(student)).send({ code })).status).toBe(200)
    const again = await request(app).post(`${api}/tasks/${event.id}/checkin`).set(dev(student)).send({ code })
    expect(again.status).toBe(409)
  })

  test('a wrong or stale code is a 400 BAD_CODE with no hint of proximity', async () => {
    const { event, student } = await seedEvent()
    const assignment = await rsvp(event, student)

    const threeStepsStale = codeAt('SEEDSECRETA', stepIndex(Date.now()) - 3)
    for (const code of ['000000', 'wrong1', threeStepsStale]) {
      const res = await request(app).post(`${api}/tasks/${event.id}/checkin`).set(dev(student)).send({ code })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('BAD_CODE')
      expect(res.body.error.message).not.toMatch(/step|window|near|close|expired soon/i)
    }

    // Nothing was written by failed attempts.
    expect((await prisma.taskAssignment.findUnique({ where: { id: assignment.id } })).status).toBe('ACCEPTED')
  })

  test('five wrong codes lock the attendee out with 429 TOO_MANY_ATTEMPTS', async () => {
    const { event, student } = await seedEvent()
    await rsvp(event, student)

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post(`${api}/tasks/${event.id}/checkin`)
        .set(dev(student))
        .send({ code: '000000' })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('BAD_CODE')
    }

    // The sixth attempt is refused before verification, so the 429 cannot be
    // used as an oracle that the code finally became right.
    const throttled = await request(app)
      .post(`${api}/tasks/${event.id}/checkin`)
      .set(dev(student))
      .send({ code: '000000' })
    expect(throttled.status).toBe(429)
    expect(throttled.body.error.code).toBe('TOO_MANY_ATTEMPTS')
    expect(throttled.body.error.details.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(throttled.body.error.details.retryAfterSeconds).toBeLessThanOrEqual(300)

    const withCorrectCode = await request(app)
      .post(`${api}/tasks/${event.id}/checkin`)
      .set(dev(student))
      .send({ code: currentCode('SEEDSECRETA') })
    expect(withCorrectCode.status).toBe(429)

    expect(
      (await prisma.taskAssignment.findFirst({ where: { taskId: event.id } })).status,
    ).toBe('ACCEPTED')
  })

  test('a correct code within budget still succeeds before the cap', async () => {
    const { event, student } = await seedEvent()
    await rsvp(event, student)

    for (let i = 0; i < 4; i++) {
      expect(
        (
          await request(app)
            .post(`${api}/tasks/${event.id}/checkin`)
            .set(dev(student))
            .send({ code: 'nope' })
        ).status,
      ).toBe(400)
    }

    const res = await request(app)
      .post(`${api}/tasks/${event.id}/checkin`)
      .set(dev(student))
      .send({ code: currentCode('SEEDSECRETA') })
    expect(res.status).toBe(200)
    expect(res.body.assignment.status).toBe('COMPLETED')
  })

  test('a successful check-in clears the miss counter', async () => {
    const { event, student } = await seedEvent()
    await rsvp(event, student)

    for (let i = 0; i < 4; i++) {
      await request(app).post(`${api}/tasks/${event.id}/checkin`).set(dev(student)).send({ code: 'nope' })
    }
    // A second attendee on the same event has a budget of their own.
    const other = await createUser({ name: 'Second Attendee' })
    await rsvp(event, other)

    expect(
      (
        await request(app)
          .post(`${api}/tasks/${event.id}/checkin`)
          .set(dev(student))
          .send({ code: currentCode('SEEDSECRETA') })
      ).status,
    ).toBe(200)

    // The other attendee is untouched by anyone else's misses.
    expect(
      (
        await request(app)
          .post(`${api}/tasks/${event.id}/checkin`)
          .set(dev(other))
          .send({ code: currentCode('SEEDSECRETA') })
      ).status,
    ).toBe(200)
  })

  test('a code one step old still validates (clock drift tolerance)', async () => {
    const { event, student } = await seedEvent()
    await rsvp(event, student)
    const drifted = codeAt('SEEDSECRETA', stepIndex(Date.now()) - 1)
    const res = await request(app).post(`${api}/tasks/${event.id}/checkin`).set(dev(student)).send({ code: drifted })
    expect(res.status).toBe(200)
  })

  test('someone without an accepted RSVP is a 403', async () => {
    const { event } = await seedEvent()
    const stranger = await createUser({ name: 'Stranger' })
    const res = await request(app)
      .post(`${api}/tasks/${event.id}/checkin`)
      .set(dev(stranger))
      .send({ code: currentCode('SEEDSECRETA') })
    expect(res.status).toBe(403)
  })

  test('a merely-applied (not accepted) attendee is a 403', async () => {
    const { event, student } = await seedEvent({ acceptanceMode: 'APPROVAL' })
    await prisma.taskAssignment.create({
      data: { taskId: event.id, takerId: student.id, status: 'APPLIED' },
    })
    const res = await request(app)
      .post(`${api}/tasks/${event.id}/checkin`)
      .set(dev(student))
      .send({ code: currentCode('SEEDSECRETA') })
    expect(res.status).toBe(403)
  })

  test('a cancelled event takes no more check-ins', async () => {
    const { event, student } = await seedEvent()
    await rsvp(event, student)
    await prisma.task.update({ where: { id: event.id }, data: { status: 'CANCELLED' } })

    const res = await request(app)
      .post(`${api}/tasks/${event.id}/checkin`)
      .set(dev(student))
      .send({ code: currentCode('SEEDSECRETA') })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('TASK_CLOSED')
    expect(
      (await prisma.taskAssignment.findFirst({ where: { taskId: event.id } })).status,
    ).toBe('ACCEPTED')
  })

  test('a completed event takes no more check-ins', async () => {
    const { event, student } = await seedEvent()
    await rsvp(event, student)
    await prisma.task.update({ where: { id: event.id }, data: { status: 'COMPLETED' } })

    const res = await request(app)
      .post(`${api}/tasks/${event.id}/checkin`)
      .set(dev(student))
      .send({ code: currentCode('SEEDSECRETA') })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('TASK_CLOSED')
  })

  test('a full event LOCKED at the door still takes check-ins', async () => {
    const { event, student } = await seedEvent({ maxTakers: 1 })
    await rsvp(event, student)
    await prisma.task.update({ where: { id: event.id }, data: { status: 'LOCKED' } })

    const res = await request(app)
      .post(`${api}/tasks/${event.id}/checkin`)
      .set(dev(student))
      .send({ code: currentCode('SEEDSECRETA') })
    expect(res.status).toBe(200)
    expect(res.body.assignment.status).toBe('COMPLETED')
  })

  test('non-events and unknown ids are 404', async () => {
    const { organizer, student } = await seedEvent()
    const tag = await prisma.tag.create({ data: { name: `t-${crypto.randomUUID()}`, category: 'ERRAND' } })
    const requestTask = await prisma.task.create({
      data: {
        title: 'Fix my bike',
        content: 'Chain slipped',
        type: 'REQUEST',
        acceptanceMode: 'AUTO',
        posterId: organizer.id,
        tags: { create: [{ tagId: tag.id }] },
      },
    })
    await prisma.taskAssignment.create({
      data: { taskId: requestTask.id, takerId: student.id, status: 'ACCEPTED' },
    })
    expect(
      (await request(app)
        .post(`${api}/tasks/${requestTask.id}/checkin`)
        .set(dev(student))
        .send({ code: '123456' })).status,
    ).toBe(404)
    expect(
      (await request(app)
        .post(`${api}/tasks/${crypto.randomUUID()}/checkin`)
        .set(dev(student))
        .send({ code: '123456' })).status,
    ).toBe(404)
  })

  test('check-in fans task:updated out with fresh occupancy', async () => {
    const { event, student } = await seedEvent({ maxTakers: 2 })
    await rsvp(event, student)

    const sock = await connect(student)
    await new Promise((resolve) => sock.emit('subscribe', { taskId: event.id }, resolve))

    const updated = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for task:updated')), 5000)
      sock.on('task:updated', (payload) => {
        clearTimeout(timer)
        resolve(payload)
      })
    })
    expect(
      (
        await request(app)
          .post(`${api}/tasks/${event.id}/checkin`)
          .set(dev(student))
          .send({ code: currentCode('SEEDSECRETA') })
      ).status,
    ).toBe(200)

    await expect(updated).resolves.toEqual({
      taskId: event.id,
      status: 'OPEN',
      takenCount: 1,
      spotsLeft: 1,
    })
  })

  test('checking in the last seat settles the event to COMPLETED immediately', async () => {
    const { event, student } = await seedEvent({ maxTakers: 1 })
    await rsvp(event, student)

    expect(
      (
        await request(app)
          .post(`${api}/tasks/${event.id}/checkin`)
          .set(dev(student))
          .send({ code: currentCode('SEEDSECRETA') })
      ).status,
    ).toBe(200)

    // No follow-up request: the handler itself drove OPEN -> LOCKED -> COMPLETED.
    const row = await prisma.task.findUnique({ where: { id: event.id } })
    expect(row.status).toBe('COMPLETED')
  })
})
