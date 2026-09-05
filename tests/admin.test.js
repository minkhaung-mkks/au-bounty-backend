import { describe, test, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/lib/prisma.js'
import { appWith, createUser, resetDb } from './helpers.js'

const api = '/aubounty/api'

let admin
let student
let teacher
let app

beforeEach(async () => {
  await resetDb()
  admin = await createUser({ name: 'Admin One', role: 'ADMIN' })
  student = await createUser({ name: 'Student Two', role: 'STUDENT', universityId: '6701002' })
  teacher = await createUser({ name: 'Teacher Three', role: 'TEACHER' })
  app = appWith()
})

const as = (user) => ({ 'x-dev-user-id': user.id })

/** A published review hanging off a finished task, ready for moderation. */
async function seedReview({ textHidden = false } = {}) {
  const poster = await createUser({ name: 'Poster' })
  const task = await prisma.task.create({
    data: { title: 'Reviewed task', content: 'c', type: 'REQUEST', posterId: poster.id },
  })
  const review = await prisma.review.create({
    data: {
      taskId: task.id,
      reviewerId: poster.id,
      revieweeId: student.id,
      rating: 2,
      text: 'Harsh but honest wording.',
      published: true,
      textHidden,
    },
  })
  return { poster, task, review }
}

/** Alert rows inserted directly; creation belongs to the emergency track. */
async function seedAlert(overrides = {}) {
  const user = overrides.user ?? (await createUser({ name: 'Alerting Student' }))
  const alert = await prisma.emergencyAlert.create({
    data: { userId: user.id, lat: 13.61, lng: 100.71, message: 'help', ...overrides },
  })
  return { user, alert }
}

/* --------------------------------------------------------- RBAC matrix */

// Every console endpoint refuses students and teachers before any lookup runs.
const matrix = [
  ['patch', '/admin/users/:id/role', { role: 'TEACHER' }],
  ['post', '/admin/orgs', { name: 'Matrix Org', description: '' }],
  ['patch', '/admin/orgs/:id', { name: 'Matrix Org' }],
  ['post', '/admin/orgs/:id/members', { userId: '123e4567-e89b-12d3-a456-426614174000', position: 'Member' }],
  ['delete', '/admin/orgs/:id/members/123e4567-e89b-12d3-a456-426614174000', null],
  ['post', '/admin/tags', { name: 'Matrix', category: 'ACADEMIC' }],
  ['patch', '/admin/reviews/:id/hide-text', { hidden: true }],
  ['get', '/admin/alerts', null],
  ['patch', '/admin/alerts/:id', { status: 'RESOLVED' }],
]

describe('admin RBAC matrix', () => {
  test.each(matrix)('%s %s is admin-only', async (method, path, body) => {
    const target = path.replaceAll(':id', '123e4567-e89b-42d3-a456-426614174000')

    for (const caller of [student, teacher]) {
      const res = await request(app)[method](`${api}${target}`).set(as(caller)).send(body)
      expect(res.status, `${method} ${target} as ${caller.role}`).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
    }

    const anon = await request(app)[method](`${api}${target}`).send(body)
    expect(anon.status).toBe(401)
  })
})

/* ------------------------------------------------------------ role change */

describe('PATCH /admin/users/:id/role', () => {
  test('changes a role and returns the serialized user', async () => {
    const res = await request(app)
      .patch(`${api}/admin/users/${student.id}/role`)
      .set(as(admin))
      .send({ role: 'TEACHER' })

    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({
      id: student.id,
      name: 'Student Two',
      role: 'TEACHER',
      universityId: '6701002',
    })
    expect(await prisma.user.findUnique({ where: { id: student.id } })).toMatchObject({
      role: 'TEACHER',
    })
  })

  test('an admin cannot change their own role', async () => {
    const res = await request(app)
      .patch(`${api}/admin/users/${admin.id}/role`)
      .set(as(admin))
      .send({ role: 'STUDENT' })

    expect(res.status).toBe(409)
  })

  test('SERVICE accounts keep their role', async () => {
    const service = await createUser({ name: 'Peer Service', role: 'SERVICE' })
    const res = await request(app)
      .patch(`${api}/admin/users/${service.id}/role`)
      .set(as(admin))
      .send({ role: 'ADMIN' })

    expect(res.status).toBe(409)
    expect(await prisma.user.findUnique({ where: { id: service.id } })).toMatchObject({
      role: 'SERVICE',
    })
  })

  test('unknown user is 404, SERVICE as a target value is 400', async () => {
    const missing = await request(app)
      .patch(`${api}/admin/users/123e4567-e89b-42d3-a456-426614174000/role`)
      .set(as(admin))
      .send({ role: 'TEACHER' })
    expect(missing.status).toBe(404)

    const badRole = await request(app)
      .patch(`${api}/admin/users/${student.id}/role`)
      .set(as(admin))
      .send({ role: 'SERVICE' })
    expect(badRole.status).toBe(400)
  })
})

/* ------------------------------------------------------------------- orgs */

describe('admin orgs', () => {
  test('create, edit, and name-uniqueness', async () => {
    const created = await request(app)
      .post(`${api}/admin/orgs`)
      .set(as(admin))
      .send({ name: 'Robotics Club', description: 'Builds robots.' })
    expect(created.status).toBe(201)
    expect(created.body.org).toMatchObject({ name: 'Robotics Club', description: 'Builds robots.' })
    expect(created.body.org.id).toBeTruthy()

    const duplicate = await request(app)
      .post(`${api}/admin/orgs`)
      .set(as(admin))
      .send({ name: 'Robotics Club' })
    expect(duplicate.status).toBe(409)

    const edited = await request(app)
      .patch(`${api}/admin/orgs/${created.body.org.id}`)
      .set(as(admin))
      .send({ description: 'Builds better robots.' })
    expect(edited.status).toBe(200)
    expect(edited.body.org).toMatchObject({
      name: 'Robotics Club',
      description: 'Builds better robots.',
    })

    const renamed = await request(app)
      .patch(`${api}/admin/orgs/${created.body.org.id}`)
      .set(as(admin))
      .send({ name: 'Robotics Society' })
    expect(renamed.status).toBe(200)
    expect(renamed.body.org.name).toBe('Robotics Society')

    // Renaming onto another org's name is a conflict too.
    const second = await request(app)
      .post(`${api}/admin/orgs`)
      .set(as(admin))
      .send({ name: 'Chess Club', description: '' })
    const clash = await request(app)
      .patch(`${api}/admin/orgs/${second.body.org.id}`)
      .set(as(admin))
      .send({ name: 'Robotics Society' })
    expect(clash.status).toBe(409)

    const missing = await request(app)
      .patch(`${api}/admin/orgs/123e4567-e89b-42d3-a456-426614174000`)
      .set(as(admin))
      .send({ name: 'Ghost Club' })
    expect(missing.status).toBe(404)
  })

  test('membership add, duplicate, and remove', async () => {
    const org = await prisma.organization.create({ data: { name: 'Photo Club' } })

    const added = await request(app)
      .post(`${api}/admin/orgs/${org.id}/members`)
      .set(as(admin))
      .send({ userId: student.id, position: 'President' })
    expect(added.status).toBe(201)
    expect(added.body.membership).toMatchObject({
      orgId: org.id,
      userId: student.id,
      position: 'President',
    })

    const duplicate = await request(app)
      .post(`${api}/admin/orgs/${org.id}/members`)
      .set(as(admin))
      .send({ userId: student.id, position: 'Member' })
    expect(duplicate.status).toBe(409)

    const unknownUser = await request(app)
      .post(`${api}/admin/orgs/${org.id}/members`)
      .set(as(admin))
      .send({ userId: '123e4567-e89b-42d3-a456-426614174000', position: 'Member' })
    expect(unknownUser.status).toBe(404)

    const unknownOrg = await request(app)
      .post(`${api}/admin/orgs/123e4567-e89b-42d3-a456-426614174000/members`)
      .set(as(admin))
      .send({ userId: teacher.id, position: 'Member' })
    expect(unknownOrg.status).toBe(404)

    const removed = await request(app)
      .delete(`${api}/admin/orgs/${org.id}/members/${student.id}`)
      .set(as(admin))
    expect(removed.status).toBe(204)
    expect(await prisma.orgMembership.count({ where: { orgId: org.id } })).toBe(0)

    const again = await request(app)
      .delete(`${api}/admin/orgs/${org.id}/members/${student.id}`)
      .set(as(admin))
    expect(again.status).toBe(404)
  })
})

/* ------------------------------------------------------------------- tags */

describe('POST /admin/tags', () => {
  test('grows the curated list and rejects duplicates and bad categories', async () => {
    const created = await request(app)
      .post(`${api}/admin/tags`)
      .set(as(admin))
      .send({ name: 'Thai Sign Language', category: 'LANGUAGE' })
    expect(created.status).toBe(201)
    expect(created.body.tag).toMatchObject({ name: 'Thai Sign Language', category: 'LANGUAGE' })

    const duplicate = await request(app)
      .post(`${api}/admin/tags`)
      .set(as(admin))
      .send({ name: 'Thai Sign Language', category: 'ACADEMIC' })
    expect(duplicate.status).toBe(409)

    const badCategory = await request(app)
      .post(`${api}/admin/tags`)
      .set(as(admin))
      .send({ name: 'Another Tag', category: 'SPORTS' })
    expect(badCategory.status).toBe(400)
    expect(badCategory.body.error.code).toBe('BAD_REQUEST')
  })
})

/* ------------------------------------------------------------- moderation */

describe('PATCH /admin/reviews/:id/hide-text', () => {
  test('hides wording on the public profile but the rating still counts', async () => {
    const { review } = await seedReview()

    const hidden = await request(app)
      .patch(`${api}/admin/reviews/${review.id}/hide-text`)
      .set(as(admin))
      .send({ hidden: true })
    expect(hidden.status).toBe(200)
    expect(hidden.body.review.textHidden).toBe(true)
    expect(hidden.body.review.rating).toBe(2)

    // Public profile: text masked, rating row still rendered and still in the
    // average. Moderation can never inflate a score.
    const profile = await request(app).get(`${api}/users/${student.id}`)
    expect(profile.status).toBe(200)
    const row = profile.body.reviews.find((r) => r.id === review.id)
    expect(row).toMatchObject({ rating: 2, text: null, textHidden: true })
    expect(profile.body.stats).toMatchObject({ reviewCount: 1, rating: 2 })

    const unhidden = await request(app)
      .patch(`${api}/admin/reviews/${review.id}/hide-text`)
      .set(as(admin))
      .send({ hidden: false })
    expect(unhidden.status).toBe(200)
    expect(unhidden.body.review.textHidden).toBe(false)

    const restored = await request(app).get(`${api}/users/${student.id}`)
    expect(restored.body.reviews.find((r) => r.id === review.id).text).toBe(
      'Harsh but honest wording.',
    )
  })

  test('unknown review is 404 and non-boolean bodies are 400', async () => {
    const missing = await request(app)
      .patch(`${api}/admin/reviews/123e4567-e89b-42d3-a456-426614174000/hide-text`)
      .set(as(admin))
      .send({ hidden: true })
    expect(missing.status).toBe(404)

    const notBoolean = await request(app)
      .patch(`${api}/admin/reviews/123e4567-e89b-42d3-a456-426614174000/hide-text`)
      .set(as(admin))
      .send({ hidden: 'yes' })
    expect(notBoolean.status).toBe(400)
  })
})

/* ----------------------------------------------------------------- alerts */

describe('GET /admin/alerts', () => {
  test('lists newest first with identity cards, filters by status', async () => {
    const oldest = await seedAlert({ createdAt: new Date(Date.now() - 3 * 60 * 1000) })
    const newest = await seedAlert({
      createdAt: new Date(Date.now() - 1 * 60 * 1000),
      status: 'RESOLVED',
      resolvedAt: new Date(Date.now() - 30 * 1000),
      forwardedToPeer: true,
      message: 'forwarded one',
    })
    const flagged = await seedAlert({
      createdAt: new Date(Date.now() - 2 * 60 * 1000),
      status: 'FLAGGED',
    })

    const all = await request(app).get(`${api}/admin/alerts`).set(as(admin))
    expect(all.status).toBe(200)
    expect(all.body.alerts.map((a) => a.id)).toEqual([
      newest.alert.id,
      flagged.alert.id,
      oldest.alert.id,
    ])
    expect(all.body.alerts[0]).toMatchObject({
      id: newest.alert.id,
      user: { id: newest.user.id, name: 'Alerting Student', universityId: null },
      lat: 13.61,
      lng: 100.71,
      message: 'forwarded one',
      status: 'RESOLVED',
      forwardedToPeer: true,
    })
    expect(all.body.alerts[0].resolvedAt).toBeTruthy()
    expect(all.body.alerts[2].status).toBe('ACTIVE')

    const activeOnly = await request(app).get(`${api}/admin/alerts?status=ACTIVE`).set(as(admin))
    expect(activeOnly.status).toBe(200)
    expect(activeOnly.body.alerts.map((a) => a.status)).toEqual(['ACTIVE'])

    const resolvedOnly = await request(app).get(`${api}/admin/alerts?status=RESOLVED`).set(as(admin))
    expect(resolvedOnly.body.alerts.map((a) => a.id)).toEqual([newest.alert.id])

    const badStatus = await request(app).get(`${api}/admin/alerts?status=CANCELLED`).set(as(admin))
    expect(badStatus.status).toBe(400)
  })
})

describe('PATCH /admin/alerts/:id', () => {
  test('resolving stamps resolvedAt once; flagging keeps the original stamp', async () => {
    const { alert } = await seedAlert()
    const firstStamp = new Date(Date.now() - 60 * 1000)

    const resolved = await request(app)
      .patch(`${api}/admin/alerts/${alert.id}`)
      .set(as(admin))
      .send({ status: 'RESOLVED' })
    expect(resolved.status).toBe(200)
    expect(resolved.body.alert.status).toBe('RESOLVED')
    expect(resolved.body.alert.resolvedAt).toBeTruthy()

    // Resolving again never re-stamps.
    await prisma.emergencyAlert.update({ where: { id: alert.id }, data: { resolvedAt: firstStamp } })
    const reResolved = await request(app)
      .patch(`${api}/admin/alerts/${alert.id}`)
      .set(as(admin))
      .send({ status: 'RESOLVED' })
    expect(reResolved.status).toBe(200)
    expect(new Date(reResolved.body.alert.resolvedAt).getTime()).toBe(firstStamp.getTime())

    // Flagging a resolved alert is allowed and preserves the resolution time.
    const flagged = await request(app)
      .patch(`${api}/admin/alerts/${alert.id}`)
      .set(as(admin))
      .send({ status: 'FLAGGED' })
    expect(flagged.status).toBe(200)
    expect(flagged.body.alert.status).toBe('FLAGGED')
    expect(new Date(flagged.body.alert.resolvedAt).getTime()).toBe(firstStamp.getTime())
  })

  test('unknown alert is 404, ACTIVE is not a valid transition', async () => {
    const missing = await request(app)
      .patch(`${api}/admin/alerts/123e4567-e89b-42d3-a456-426614174000`)
      .set(as(admin))
      .send({ status: 'RESOLVED' })
    expect(missing.status).toBe(404)

    const { alert } = await seedAlert()
    const reopen = await request(app)
      .patch(`${api}/admin/alerts/${alert.id}`)
      .set(as(admin))
      .send({ status: 'ACTIVE' })
    expect(reopen.status).toBe(400)
  })
})
