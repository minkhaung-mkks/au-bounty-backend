import { describe, test, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/lib/prisma.js'
import { appWith, createUser, resetDb } from './helpers.js'

const api = '/aubounty/api'
const dev = (user) => ({ 'x-dev-user-id': user.id })
const app = appWith()

beforeEach(async () => {
  await resetDb()
})

/** Poster + org + tag around one EVENT, the shape the orgId guard protects. */
async function seedEvent() {
  const tag = await prisma.tag.create({
    data: { name: `tag-${crypto.randomUUID()}`, category: 'ERRAND' },
  })
  const org = await prisma.organization.create({ data: { name: `Org ${crypto.randomUUID().slice(0, 8)}` } })
  const poster = await createUser({ name: 'Organizer', orgIds: [org.id] })
  const otherOrg = await prisma.organization.create({
    data: { name: `Other ${crypto.randomUUID().slice(0, 8)}` },
  })
  const event = await prisma.task.create({
    data: {
      title: 'Keynote',
      content: 'Talk and pizza',
      type: 'EVENT',
      posterId: poster.id,
      orgId: org.id,
      maxTakers: 10,
      acceptanceMode: 'AUTO',
      locationName: 'Auditorium',
      checkinSecret: 'TASKTESTSECRET',
      tags: { create: [{ tagId: tag.id }] },
    },
  })
  return { tag, org, otherOrg, poster, event }
}

describe('PATCH /tasks/:id org immutability', () => {
  test('patching orgId is a 400 validation error, not a silent retag', async () => {
    const { otherOrg, poster, event } = await seedEvent()

    const res = await request(app)
      .patch(`${api}/tasks/${event.id}`)
      .set(dev(poster))
      .send({ orgId: otherOrg.id })

    expect(res.status).toBe(400)
    expect(res.body.error.details).toContainEqual({
      path: 'orgId',
      message: 'The sponsoring organization cannot be changed after posting.',
    })

    const row = await prisma.task.findUnique({ where: { id: event.id } })
    expect(row.orgId).toBe(event.orgId)
  })

  test('an explicit orgId: null is refused the same way', async () => {
    const { poster, event } = await seedEvent()
    const res = await request(app)
      .patch(`${api}/tasks/${event.id}`)
      .set(dev(poster))
      .send({ title: 'Renamed', orgId: null })
    expect(res.status).toBe(400)
    expect((await prisma.task.findUnique({ where: { id: event.id } })).orgId).toBe(event.orgId)
  })

  test('legitimate patches without orgId keep working', async () => {
    const { poster, event } = await seedEvent()

    const res = await request(app)
      .patch(`${api}/tasks/${event.id}`)
      .set(dev(poster))
      .send({ title: 'Keynote, rescheduled room', maxTakers: 150 })

    expect(res.status).toBe(200)
    expect(res.body.task.title).toBe('Keynote, rescheduled room')
    expect(res.body.task.maxTakers).toBe(150)
    // The org the event was created with rides along untouched.
    expect((await prisma.task.findUnique({ where: { id: event.id } })).orgId).toBe(event.orgId)
  })
})

describe('seat claiming is atomic', () => {
  /** An AUTO task with `seats` free and no assignments yet. */
  async function seedAutoTask(maxTakers) {
    const tag = await prisma.tag.create({
      data: { name: `tag-${crypto.randomUUID()}`, category: 'ERRAND' },
    })
    const poster = await createUser({ name: 'Poster' })
    const task = await prisma.task.create({
      data: {
        title: 'First-come seat',
        content: 'One spot only',
        type: 'REQUEST',
        posterId: poster.id,
        maxTakers,
        acceptanceMode: 'AUTO',
        tags: { create: [{ tagId: tag.id }] },
      },
    })
    return { poster, task }
  }

  test('two simultaneous applies for the last seat: exactly one gets it', async () => {
    const { task } = await seedAutoTask(1)
    const one = await createUser({ name: 'First' })
    const two = await createUser({ name: 'Second' })

    const [a, b] = await Promise.all([
      request(app).post(`${api}/tasks/${task.id}/apply`).set(dev(one)),
      request(app).post(`${api}/tasks/${task.id}/apply`).set(dev(two)),
    ])

    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 409])
    const rows = await prisma.taskAssignment.findMany({ where: { taskId: task.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('ACCEPTED')
  })

  test('poster accept cannot push occupancy past maxTakers', async () => {
    const { poster, task } = await seedAutoTask(1)
    await prisma.task.update({ where: { id: task.id }, data: { acceptanceMode: 'APPROVAL' } })

    const seated = await createUser({ name: 'Seated' })
    const waiting = await createUser({ name: 'Waiting' })
    await prisma.taskAssignment.create({
      data: { taskId: task.id, takerId: seated.id, status: 'ACCEPTED' },
    })
    const applied = await prisma.taskAssignment.create({
      data: { taskId: task.id, takerId: waiting.id, status: 'APPLIED' },
    })

    const res = await request(app)
      .post(`${api}/assignments/${applied.id}/accept`)
      .set(dev(poster))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT')

    expect(
      (await prisma.taskAssignment.findUnique({ where: { id: applied.id } })).status,
    ).toBe('APPLIED')
    expect(
      (await prisma.taskAssignment.count({ where: { taskId: task.id, status: 'ACCEPTED' } })),
    ).toBe(1)
  })
})
