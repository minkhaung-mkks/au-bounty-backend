import { describe, test, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/lib/prisma.js'
import { appWith, createUser, resetDb, sessionCookie } from './helpers.js'

const api = '/aubounty/api'
const MESSAGE_FIELDS = ['id', 'assignmentId', 'senderId', 'content', 'createdAt', 'readAt']

beforeEach(async () => {
  await resetDb()
})

async function seedThread({ status = 'ACCEPTED' } = {}) {
  const tag = await prisma.tag.create({
    data: { name: `tag-${crypto.randomUUID()}`, category: 'ERRAND' },
  })
  const poster = await createUser({ name: 'Poster' })
  const taker = await createUser({ name: 'Taker' })
  const outsider = await createUser({ name: 'Outsider' })
  const task = await prisma.task.create({
    data: {
      title: 'Carry boxes',
      content: 'Heavy things down two flights',
      type: 'REQUEST',
      posterId: poster.id,
      locationName: 'A Block',
      tags: { create: [{ tagId: tag.id }] },
    },
  })
  const assignment = await prisma.taskAssignment.create({
    data: { taskId: task.id, takerId: taker.id, status },
  })
  return { poster, taker, outsider, task, assignment }
}

/** Posts straight to the db with a controlled clock for ordering. */
async function say(assignmentId, senderId, content, at) {
  return prisma.message.create({
    data: { assignmentId, senderId, content, ...(at ? { createdAt: at } : {}) },
  })
}

const dev = (user) => ({ 'x-dev-user-id': user.id })

/* -------------------------------------------------------------------------- */

describe('GET /assignments/:id/messages', () => {
  test('both participants read, anyone else is locked out', async () => {
    const app = appWith()
    const { poster, taker, outsider, assignment } = await seedThread()
    await say(assignment.id, poster.id, 'hello')

    const asPoster = await request(app)
      .get(`${api}/assignments/${assignment.id}/messages`)
      .set(dev(poster))
    expect(asPoster.status).toBe(200)
    expect(asPoster.body.messages).toHaveLength(1)

    const asTaker = await request(app)
      .get(`${api}/assignments/${assignment.id}/messages`)
      .set('Cookie', await sessionCookie(taker))
    expect(asTaker.status).toBe(200)

    const asOutsider = await request(app)
      .get(`${api}/assignments/${assignment.id}/messages`)
      .set(dev(outsider))
    expect(asOutsider.status).toBe(403)

    const anon = await request(app).get(`${api}/assignments/${assignment.id}/messages`)
    expect(anon.status).toBe(401)

    const ghost = await request(app)
      .get(`${api}/assignments/00000000-0000-0000-0000-000000000000/messages`)
      .set(dev(poster))
    expect(ghost.status).toBe(404)
  })

  test('every model field is present, ascending, with a working before cursor', async () => {
    const app = appWith()
    const { poster, taker, assignment } = await seedThread()
    const base = Date.now() - 60_000
    const sent = []
    for (let i = 0; i < 6; i++) {
      sent.push(
        await say(
          assignment.id,
          i % 2 ? taker.id : poster.id,
          `m${i + 1}`,
          new Date(base + i * 10),
        ),
      )
    }

    const page = await request(app)
      .get(`${api}/assignments/${assignment.id}/messages`)
      .set(dev(taker))
    expect(page.status).toBe(200)
    expect(page.body.hasMore).toBe(false)
    expect(page.body.messages.map((m) => m.content)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])
    expect(Object.keys(page.body.messages[0]).sort()).toEqual(MESSAGE_FIELDS.slice().sort())
    expect(page.body.messages[0].id).toBe(sent[0].id)

    const tail = await request(app)
      .get(`${api}/assignments/${assignment.id}/messages?limit=2`)
      .set(dev(taker))
    expect(tail.body.hasMore).toBe(true)
    expect(tail.body.messages.map((m) => m.content)).toEqual(['m5', 'm6'])

    const older = await request(app)
      .get(`${api}/assignments/${assignment.id}/messages?before=${sent[4].id}&limit=2`)
      .set(dev(taker))
    expect(older.body.hasMore).toBe(true)
    expect(older.body.messages.map((m) => m.content)).toEqual(['m3', 'm4'])

    const last = await request(app)
      .get(`${api}/assignments/${assignment.id}/messages?before=${sent[1].id}&limit=2`)
      .set(dev(taker))
    expect(last.body.hasMore).toBe(false)
    expect(last.body.messages.map((m) => m.content)).toEqual(['m1'])
  })

  test('a cursor borrowed from another thread is rejected', async () => {
    const app = appWith()
    const a = await seedThread()
    const b = await seedThread()
    const foreign = await say(b.assignment.id, b.poster.id, 'other thread')

    const res = await request(app)
      .get(`${api}/assignments/${a.assignment.id}/messages?before=${foreign.id}`)
      .set(dev(a.taker))
    expect(res.status).toBe(400)
  })
})

describe('POST /assignments/:id/messages', () => {
  test('a participant posts and gets the full row back', async () => {
    const app = appWith()
    const { poster, taker, outsider, assignment } = await seedThread()

    const ok = await request(app)
      .post(`${api}/assignments/${assignment.id}/messages`)
      .set('Cookie', await sessionCookie(poster))
      .send({ content: 'on my way' })
    expect(ok.status).toBe(201)
    expect(ok.body.message).toMatchObject({
      assignmentId: assignment.id,
      senderId: poster.id,
      content: 'on my way',
      readAt: null,
    })
    expect(await prisma.message.count({ where: { assignmentId: assignment.id } })).toBe(1)

    const locked = await request(app)
      .post(`${api}/assignments/${assignment.id}/messages`)
      .set(dev(outsider))
      .send({ content: 'let me in' })
    expect(locked.status).toBe(403)

    const anon = await request(app)
      .post(`${api}/assignments/${assignment.id}/messages`)
      .send({ content: 'who dis' })
    expect(anon.status).toBe(401)
  })

  test('content must be 1..4000 visible characters', async () => {
    const app = appWith()
    const { taker, assignment } = await seedThread()

    const empty = await request(app)
      .post(`${api}/assignments/${assignment.id}/messages`)
      .set(dev(taker))
      .send({ content: '' })
    expect(empty.status).toBe(400)

    const blank = await request(app)
      .post(`${api}/assignments/${assignment.id}/messages`)
      .set(dev(taker))
      .send({ content: '   ' })
    expect(blank.status).toBe(400)

    const missing = await request(app)
      .post(`${api}/assignments/${assignment.id}/messages`)
      .set(dev(taker))
      .send({})
    expect(missing.status).toBe(400)

    const tooLong = await request(app)
      .post(`${api}/assignments/${assignment.id}/messages`)
      .set(dev(taker))
      .send({ content: 'x'.repeat(4001) })
    expect(tooLong.status).toBe(400)

    const edge = await request(app)
      .post(`${api}/assignments/${assignment.id}/messages`)
      .set(dev(taker))
      .send({ content: 'x'.repeat(4000) })
    expect(edge.status).toBe(201)
    expect(edge.body.message.content).toHaveLength(4000)
  })
})

describe('POST /assignments/:id/read', () => {
  test('marks only the counterpart unread messages, exactly once', async () => {
    const app = appWith()
    const { poster, taker, outsider, assignment } = await seedThread()
    const fromPoster = [
      await say(assignment.id, poster.id, 'p1'),
      await say(assignment.id, poster.id, 'p2'),
    ]
    const fromTaker = [
      await say(assignment.id, taker.id, 't1'),
      await say(assignment.id, taker.id, 't2'),
    ]

    const locked = await request(app)
      .post(`${api}/assignments/${assignment.id}/read`)
      .set(dev(outsider))
    expect(locked.status).toBe(403)

    const read = await request(app)
      .post(`${api}/assignments/${assignment.id}/read`)
      .set('Cookie', await sessionCookie(taker))
    expect(read.status).toBe(204)

    const rows = await prisma.message.findMany({ where: { assignmentId: assignment.id } })
    const byId = new Map(rows.map((m) => [m.id, m]))
    for (const m of fromPoster) expect(byId.get(m.id).readAt).not.toBeNull()
    // The reader's own messages are never touched.
    for (const m of fromTaker) expect(byId.get(m.id).readAt).toBeNull()

    const again = await request(app)
      .post(`${api}/assignments/${assignment.id}/read`)
      .set('Cookie', await sessionCookie(taker))
    expect(again.status).toBe(204)
    const after = await prisma.message.findMany({ where: { assignmentId: assignment.id } })
    expect(new Set(after.map((m) => m.readAt?.getTime() ?? null))).toEqual(
      new Set(rows.map((m) => m.readAt?.getTime() ?? null)),
    )
  })
})

describe('GET /me/threads', () => {
  test('orders by last activity and counts unread from the counterpart only', async () => {
    const app = appWith()
    const taker = await createUser({ name: 'Taker' })
    const tag = await prisma.tag.create({
      data: { name: `tag-${crypto.randomUUID()}`, category: 'ERRAND' },
    })
    const base = Date.now() - 120_000

    const thread = async (name, appliedAt) => {
      const poster = await createUser({ name })
      const task = await prisma.task.create({
        data: {
          title: `Task ${name}`,
          content: 'c',
          type: 'REQUEST',
          posterId: poster.id,
          locationName: 'Library',
          tags: { create: [{ tagId: tag.id }] },
        },
      })
      return prisma.taskAssignment.create({
        data: { taskId: task.id, takerId: taker.id, status: 'ACCEPTED', appliedAt },
      })
    }

    const a = await thread('Poster A', new Date(base))
    const b = await thread('Poster B', new Date(base + 1000))
    const c = await thread('Poster C', new Date(base + 2000))

    await say(a.id, (await prisma.taskAssignment.findUnique({ where: { id: a.id } })).takerId, 'ignore', new Date(base + 3000))
    const posterA = await prisma.task.findUnique({ where: { id: a.taskId } })
    await say(a.id, posterA.posterId, 'a1', new Date(base + 4000))
    await say(a.id, posterA.posterId, 'a2', new Date(base + 5000))

    const bRow = await prisma.taskAssignment.findUnique({ where: { id: b.id } })
    const posterB = await prisma.task.findUnique({ where: { id: bRow.taskId } })
    await say(b.id, posterB.posterId, 'b1', new Date(base + 6000))
    await say(b.id, taker.id, 'b2', new Date(base + 7000))

    // The taker caught up on thread B, so only A still badges.
    expect(
      (
        await request(app)
          .post(`${api}/assignments/${b.id}/read`)
          .set(dev(taker))
      ).status,
    ).toBe(204)

    const res = await request(app).get(`${api}/me/threads`).set(dev(taker))
    expect(res.status).toBe(200)
    expect(res.body.threads.map((t) => t.assignmentId)).toEqual([b.id, a.id, c.id])

    const [tb, ta, tc] = res.body.threads
    expect(tb.unreadCount).toBe(0) // everything from poster B is read
    expect(tb.lastMessage).toMatchObject({ content: 'b2', senderId: taker.id })
    expect(tb.counterpart).toEqual({ id: posterB.posterId, name: 'Poster B' })
    expect(tb.taskType).toBe('REQUEST')

    expect(ta.unreadCount).toBe(2)
    expect(ta.lastMessage).toMatchObject({ content: 'a2', senderId: posterA.posterId })
    expect(ta.counterpart).toEqual({ id: posterA.posterId, name: 'Poster A' })

    expect(tc.lastMessage).toBeNull()
    expect(tc.unreadCount).toBe(0)
  })

  test('the poster side sees the taker as counterpart', async () => {
    const app = appWith()
    const { poster, taker, assignment } = await seedThread()
    await say(assignment.id, taker.id, 'done yet?')

    const res = await request(app).get(`${api}/me/threads`).set(dev(poster))
    expect(res.status).toBe(200)
    expect(res.body.threads).toHaveLength(1)
    expect(res.body.threads[0]).toMatchObject({
      assignmentId: assignment.id,
      counterpart: { id: taker.id, name: 'Taker' },
      unreadCount: 1,
    })
  })

  test('withdrawn and rejected assignments never appear', async () => {
    const app = appWith()
    const gone = await seedThread({ status: 'WITHDRAWN' })
    const refused = await seedThread({ status: 'REJECTED' })
    const live = await seedThread()

    const forPoster = await request(app).get(`${api}/me/threads`).set(dev(live.poster))
    expect(forPoster.body.threads.map((t) => t.assignmentId)).toEqual([live.assignment.id])

    const forTakerOfGone = await request(app).get(`${api}/me/threads`).set(dev(gone.taker))
    expect(forTakerOfGone.body.threads).toEqual([])
    const forPosterOfRefused = await request(app)
      .get(`${api}/me/threads`)
      .set(dev(refused.poster))
    expect(forPosterOfRefused.body.threads).toEqual([])
  })

  test('requires a user', async () => {
    const app = appWith()
    expect((await request(app).get(`${api}/me/threads`)).status).toBe(401)
  })
})
