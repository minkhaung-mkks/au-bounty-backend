import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/lib/prisma.js'
import { appWith, createUser, resetDb } from './helpers.js'
import { sendEmail, deliverEmail, queueEmail, retryUnsentEmails } from '../src/lib/mailer.js'
import { sendConfirmWarnings, sendEventReminders } from '../src/services/mailScheduler.js'

const api = '/aubounty/api'
const dev = (user) => ({ 'x-dev-user-id': user.id })
const app = appWith({ dev: true })

// Mail env is read at call time; keep each test hermetic against backend/.env.
const savedEnv = {}
const setEnv = (name, value) => {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  setEnv('MAIL_TRANSPORT', 'console')
  setEnv('RESEND_API_KEY', undefined)
  setEnv('MAIL_FROM', undefined)
  await resetDb()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const days = (n) => n * 24 * 60 * 60 * 1000

/** A poster + taker + REQUEST task pair, seeded straight into the db. */
async function seedTask(overrides = {}) {
  const tag = await prisma.tag.create({ data: { name: `t-${crypto.randomUUID()}`, category: 'ERRAND' } })
  const poster = await createUser({ name: 'Poster Pete' })
  const taker = await createUser({ name: 'Taker Tess' })
  const task = await prisma.task.create({
    data: {
      title: 'Carry boxes downstairs',
      content: 'Two hours of lifting',
      type: 'REQUEST',
      posterId: poster.id,
      locationName: 'Dorm A',
      tags: { create: [{ tagId: tag.id }] },
      ...overrides.task,
    },
  })
  return { poster, taker, task }
}

describe('mailer transports', () => {
  test('console transport logs and still records the outbox row as sent', async () => {
    const result = await sendEmail({
      kind: 'COMPLETION_REQUESTED',
      refId: crypto.randomUUID(),
      to: 'poster@test.dev',
      subject: 'test subject',
      body: 'test body',
    })
    expect(result).toBe('sent')
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('to=poster@test.dev'))

    const rows = await prisma.emailOutbox.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'COMPLETION_REQUESTED',
      toEmail: 'poster@test.dev',
      subject: 'test subject',
      body: 'test body',
    })
    expect(rows[0].sentAt).not.toBeNull()
  })

  test('the outbox unique constraint dedupes a second identical trigger', async () => {
    const refId = crypto.randomUUID()
    const params = { kind: 'CONFIRM_WARNING', refId, to: 'a@test.dev', subject: 's', body: 'b' }
    expect(await sendEmail(params)).toBe('sent')
    expect(await sendEmail(params)).toBe('deduped')
    expect(await prisma.emailOutbox.count()).toBe(1)
  })

  test('resend transport posts to the API and marks the row sent', async () => {
    setEnv('MAIL_TRANSPORT', 'resend')
    setEnv('RESEND_API_KEY', 're_test_key')
    setEnv('MAIL_FROM', 'AU Bounty <noreply@aubounty.dev>')
    const fetchMock = vi.fn(async () => new Response('{"id":"email-1"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendEmail({
      kind: 'EVENT_REMINDER',
      refId: crypto.randomUUID(),
      to: 'taker@test.dev',
      subject: 'starts soon',
      body: 'see you there',
    })
    expect(result).toBe('sent')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer re_test_key')
    expect(JSON.parse(init.body)).toEqual({
      from: 'AU Bounty <noreply@aubounty.dev>',
      to: 'taker@test.dev',
      subject: 'starts soon',
      text: 'see you there',
    })
    expect((await prisma.emailOutbox.findFirst({})).sentAt).not.toBeNull()
  })

  test('a resend timeout leaves the row queued and the scheduler retries it', async () => {
    setEnv('MAIL_TRANSPORT', 'resend')
    setEnv('RESEND_API_KEY', 're_test_key')
    setEnv('MAIL_FROM', 'noreply@aubounty.dev')

    // Queue with real timers (it is a db write), then attempt delivery with
    // only the timeout machinery faked: the fetch below never resolves on its
    // own, so only the 10s abort can end it.
    const row = await queueEmail({
      kind: 'COMPLETION_REQUESTED',
      refId: crypto.randomUUID(),
      to: 'poster@test.dev',
      subject: 's',
      body: 'b',
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      ),
    )

    const delivery = deliverEmail(row)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(delivery).resolves.toBe(false)

    vi.useRealTimers()
    expect((await prisma.emailOutbox.findFirst({})).sentAt).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('failed'))

    // Too fresh for a retry pass (the scheduler waits out RETRY_MIN_AGE_MS)...
    expect(await retryUnsentEmails()).toBe(0)
    // ...backdate it, restore a working transport, and the scheduler delivers.
    await prisma.emailOutbox.update({
      where: { id: row.id },
      data: { createdAt: new Date(Date.now() - 120_000) },
    })
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"id":"email-1"}', { status: 200 })))
    expect(await retryUnsentEmails()).toBe(1)
    expect((await prisma.emailOutbox.findFirst({})).sentAt).not.toBeNull()
  })

  test('a resend non-2xx leaves the row queued', async () => {
    setEnv('MAIL_TRANSPORT', 'resend')
    setEnv('RESEND_API_KEY', 're_test_key')
    setEnv('MAIL_FROM', 'noreply@aubounty.dev')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"rate limited"}', { status: 429 })))

    const result = await sendEmail({
      kind: 'EVENT_REMINDER',
      refId: crypto.randomUUID(),
      to: 'taker@test.dev',
      subject: 's',
      body: 'b',
    })
    expect(result).toBe('queued')
    expect((await prisma.emailOutbox.findFirst({})).sentAt).toBeNull()
  })

  test('resend without credentials stays queued instead of guessing an endpoint', async () => {
    setEnv('MAIL_TRANSPORT', 'resend')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendEmail({
      kind: 'CONFIRM_WARNING',
      refId: crypto.randomUUID(),
      to: 'poster@test.dev',
      subject: 's',
      body: 'b',
    })
    expect(result).toBe('queued')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('marked-done trigger (COMPLETION_REQUESTED)', () => {
  test('the completion request sends exactly one email to the poster', async () => {
    const { poster, taker, task } = await seedTask({ task: { acceptanceMode: 'AUTO' } })
    expect(
      (await request(app).post(`${api}/tasks/${task.id}/apply`).set(dev(taker))).status,
    ).toBe(201)
    const assignment = await prisma.taskAssignment.findFirst({ where: { taskId: task.id } })

    const res = await request(app)
      .post(`${api}/assignments/${assignment.id}/complete`)
      .set(dev(taker))
    expect(res.status).toBe(200)

    const rows = await prisma.emailOutbox.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'COMPLETION_REQUESTED',
      refId: assignment.id,
      toEmail: poster.email,
      sentAt: expect.any(Date),
    })
    expect(rows[0].subject).toContain('Taker Tess')
    expect(rows[0].subject).toContain('Carry boxes downstairs')
    expect(rows[0].subject).toContain('please confirm')
    expect(rows[0].body).toContain('7 days')
  })

  test('a retried completion (frozen back to ACCEPTED) never double-sends', async () => {
    const { taker, task } = await seedTask({ task: { acceptanceMode: 'AUTO' } })
    await request(app).post(`${api}/tasks/${task.id}/apply`).set(dev(taker))
    const assignment = await prisma.taskAssignment.findFirst({ where: { taskId: task.id } })

    await request(app).post(`${api}/assignments/${assignment.id}/complete`).set(dev(taker))
    // Simulate the state machine being rewound (or the trigger racing).
    await prisma.taskAssignment.update({
      where: { id: assignment.id },
      data: { status: 'ACCEPTED', completionRequestedAt: null },
    })
    await request(app).post(`${api}/assignments/${assignment.id}/complete`).set(dev(taker))

    expect(await prisma.emailOutbox.count()).toBe(1)
  })
})

describe('CONFIRM_WARNING window', () => {
  const seedPending = async (ageDays) => {
    const { poster, taker, task } = await seedTask()
    return prisma.taskAssignment.create({
      data: {
        taskId: task.id,
        takerId: taker.id,
        status: 'PENDING_CONFIRMATION',
        appliedAt: new Date(Date.now() - days(ageDays + 1)),
        completionRequestedAt: new Date(Date.now() - days(ageDays)),
      },
      include: { task: { include: { poster: true } }, taker: true },
    })
  }

  test('fires at 5.5 days, never twice, and not before 5 days', async () => {
    const early = await seedPending(4.5)
    expect(await sendConfirmWarnings()).toBe(0)

    const due = await seedPending(5.5)
    expect(await sendConfirmWarnings()).toBe(1)
    const rows = await prisma.emailOutbox.findMany({ where: { kind: 'CONFIRM_WARNING' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ refId: due.id, toEmail: due.task.poster.email })
    expect(rows[0].subject).toContain('2 days left')
    expect(rows[0].body).toContain('confirmed automatically')

    expect(await sendConfirmWarnings()).toBe(0) // deduped by the outbox
    expect(early.id).not.toBe(due.id)
  })

  test('does not fire past the 7-day auto-confirm point', async () => {
    await seedPending(8)
    expect(await sendConfirmWarnings()).toBe(0)
    expect(await prisma.emailOutbox.count()).toBe(0)
  })
})

describe('EVENT_REMINDER window', () => {
  const seedEvent = async (startsInMs, takerStatuses = ['ACCEPTED']) => {
    const tag = await prisma.tag.create({ data: { name: `t-${crypto.randomUUID()}`, category: 'ACADEMIC' } })
    const organizer = await createUser({ name: 'Org', role: 'TEACHER' })
    const event = await prisma.task.create({
      data: {
        title: 'AI keynote',
        content: 'Talk and Q&A',
        type: 'EVENT',
        posterId: organizer.id,
        acceptanceMode: 'AUTO',
        locationName: 'Auditorium',
        startsAt: new Date(Date.now() + startsInMs),
        deadline: new Date(Date.now() + startsInMs + days(1)),
        tags: { create: [{ tagId: tag.id }] },
      },
    })
    const takers = []
    for (const [i, status] of takerStatuses.entries()) {
      const taker = await createUser({ name: `Attendee ${i + 1}` })
      takers.push(taker)
      await prisma.taskAssignment.create({
        data: { taskId: event.id, takerId: taker.id, status },
      })
    }
    return { event, takers }
  }

  test('fires inside the hour, once per accepted taker, never twice', async () => {
    const { event, takers } = await seedEvent(30 * 60 * 1000, ['ACCEPTED', 'ACCEPTED', 'APPLIED'])
    expect(await sendEventReminders()).toBe(2)

    const rows = await prisma.emailOutbox.findMany({ where: { kind: 'EVENT_REMINDER' } })
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.toEmail))).toEqual(
      new Set([takers[0].email, takers[1].email]),
    )
    expect(rows[0].subject).toContain('AI keynote')
    expect(rows[0].body).toContain('Auditorium')

    expect(await sendEventReminders()).toBe(0)
    expect(event.startsAt).toBeInstanceOf(Date)
  })

  test('an event outside the hour window sends nothing', async () => {
    await seedEvent(90 * 60 * 1000)
    expect(await sendEventReminders()).toBe(0)
    await seedEvent(-5 * 60 * 1000) // already started
    expect(await sendEventReminders()).toBe(0)
    expect(await prisma.emailOutbox.count()).toBe(0)
  })
})
