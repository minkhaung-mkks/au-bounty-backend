import { describe, test, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/lib/prisma.js'
import { appWith, createUser, resetDb } from './helpers.js'
import { escapeText, icsForTask } from '../src/lib/ics.js'

const api = '/aubounty/api'
const dev = (user) => ({ 'x-dev-user-id': user.id })
const app = appWith({ dev: true })

beforeEach(async () => {
  await resetDb()
})

async function seedEvent(overrides = {}) {
  const tag = await prisma.tag.create({
    data: { name: `tag-${crypto.randomUUID()}`, category: 'ERRAND' },
  })
  const organizer = await createUser({ name: 'Organizer', role: 'TEACHER' })
  const event = await prisma.task.create({
    data: {
      title: 'AI Keynote; Ethics edition',
      content: 'Talk,\nQ&A; pizza \\ drinks',
      type: 'EVENT',
      posterId: organizer.id,
      acceptanceMode: 'AUTO',
      locationName: 'Auditorium 3, Building B',
      startsAt: new Date('2026-10-01T09:00:00.000Z'),
      deadline: new Date('2026-10-01T11:30:00.000Z'),
      checkinSecret: 'SEEDSECRETA',
      tags: { create: [{ tagId: tag.id }] },
      ...overrides,
    },
  })
  return { organizer, event }
}

describe('ics escaping and folding', () => {
  test('TEXT values escape the RFC 5545 specials and newlines', () => {
    expect(escapeText('a,b;c\nd\\e')).toBe('a\\,b\\;c\\nd\\\\e')
    expect(escapeText('crlf\r\nend')).toBe('crlf\\nend')
  })

  test('every physical line of a long field stays within 75 octets', () => {
    const task = {
      id: 'x',
      title: 'T'.repeat(30),
      content: 'D'.repeat(500),
      startsAt: new Date('2026-10-01T09:00:00Z'),
      locationName: 'L'.repeat(120),
    }
    for (const line of icsForTask(task).split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75)
    }
  })

  test('folding never cuts a multi-byte character', () => {
    const task = {
      id: 'x',
      title: '้'.repeat(60), // Thai combining marks are 3-byte UTF-8
      content: 'c',
      startsAt: new Date('2026-10-01T09:00:00Z'),
    }
    const rebuilt = icsForTask(task)
      .split('\r\n')
      .map((l) => l.replace(/^ /, ''))
      .join('')
    expect(rebuilt).toContain(`SUMMARY:${'้'.repeat(60)}`)
  })
})

describe('GET /tasks/:id/calendar.ics', () => {
  test('serves a text/calendar attachment with the required properties', async () => {
    const { organizer, event } = await seedEvent()
    const res = await request(app).get(`${api}/tasks/${event.id}/calendar.ics`).set(dev(organizer))

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/calendar/)
    expect(res.headers['content-disposition']).toContain('aubounty-event.ics')

    const body = res.text
    expect(body).toContain('BEGIN:VCALENDAR')
    expect(body).toContain('END:VCALENDAR')
    expect(body).toContain(`UID:task-${event.id}@aubounty`)
    expect(body).toMatch(/DTSTAMP:\d{8}T\d{6}Z/)
    expect(body).toContain('DTSTART:20261001T090000Z')
    expect(body).toContain('DTEND:20261001T113000Z') // deadline after start wins
    expect(body).toContain('SUMMARY:AI Keynote\\; Ethics edition')
    expect(body).toContain('LOCATION:Auditorium 3\\, Building B')
    expect(body).toContain('DESCRIPTION:Talk\\,\\nQ&A\\; pizza \\\\ drinks')
    expect(body).toMatch(/\r\n$/) // CRLF line endings throughout
  })

  test('no deadline means the event runs two hours', async () => {
    const { organizer, event } = await seedEvent({ deadline: null, locationName: '' })
    const res = await request(app).get(`${api}/tasks/${event.id}/calendar.ics`).set(dev(organizer))
    expect(res.status).toBe(200)
    expect(res.text).toContain('DTSTART:20261001T090000Z')
    expect(res.text).toContain('DTEND:20261001T110000Z')
    expect(res.text).not.toContain('LOCATION:') // no location, no property
  })

  test('no startsAt falls back to the deadline as the start', async () => {
    const { organizer, event } = await seedEvent({
      startsAt: null,
      deadline: new Date('2026-10-01T11:30:00.000Z'),
      locationName: 'Auditorium 3, Building B',
    })
    const res = await request(app).get(`${api}/tasks/${event.id}/calendar.ics`).set(dev(organizer))
    expect(res.status).toBe(200)
    expect(res.text).toContain('DTSTART:20261001T113000Z')
    expect(res.text).toContain('DTEND:20261001T133000Z')
  })

  test('an event with no dates at all is a 400', async () => {
    const { organizer, event } = await seedEvent({ startsAt: null, deadline: null })
    const res = await request(app).get(`${api}/tasks/${event.id}/calendar.ics`).set(dev(organizer))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('BAD_REQUEST')
  })

  test('non-events are 404 and so are unknown ids; anonymous is 401', async () => {
    const { organizer } = await seedEvent()
    const tag = await prisma.tag.create({ data: { name: `t-${crypto.randomUUID()}`, category: 'ERRAND' } })
    const requestTask = await prisma.task.create({
      data: {
        title: 'Fix my bike',
        content: 'Chain',
        type: 'REQUEST',
        posterId: organizer.id,
        tags: { create: [{ tagId: tag.id }] },
      },
    })
    expect((await request(app).get(`${api}/tasks/${requestTask.id}/calendar.ics`).set(dev(organizer))).status).toBe(404)
    expect((await request(app).get(`${api}/tasks/${crypto.randomUUID()}/calendar.ics`).set(dev(organizer))).status).toBe(404)
    expect((await request(app).get(`${api}/tasks/${crypto.randomUUID()}/calendar.ics`)).status).toBe(401)
  })

  test('any signed-in user may download it, like the task detail', async () => {
    const { event } = await seedEvent()
    const student = await createUser({ name: 'Anyone' })
    expect((await request(app).get(`${api}/tasks/${event.id}/calendar.ics`).set(dev(student))).status).toBe(200)
  })
})
