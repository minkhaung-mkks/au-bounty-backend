import { describe, test, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { prisma } from '../src/lib/prisma.js'
import { appWith, createUser, resetDb, sessionCookie } from './helpers.js'

// Presigning is a local SigV4 computation, so the unit tests only need the
// S3 env to be *set*; nothing contacts the store. The live round-trip below
// (AUBOUNTY_TEST_S3=1) uses the real compose MinIO with real credentials.
process.env.S3_ENDPOINT ??= 'http://localhost:9100'
process.env.S3_BUCKET ??= 'aubounty'
process.env.S3_ACCESS_KEY ??= 'test-access'
process.env.S3_SECRET_KEY ??= 'test-secret'
process.env.S3_FORCE_PATH_STYLE ??= 'true'
process.env.S3_REGION ??= 'us-east-1'

const api = '/aubounty/api'
const liveS3 = process.env.AUBOUNTY_TEST_S3 === '1'
const ATTACHMENT_FIELDS = ['id', 'fileName', 'mimeType', 'sizeBytes', 'createdAt']
const dev = (user) => ({ 'x-dev-user-id': user.id })
const MB = 1024 * 1024

beforeEach(async () => {
  await resetDb()
})

/** Poster + taker + outsider + admin around one task/assignment/thread. */
async function seed() {
  const tag = await prisma.tag.create({
    data: { name: `tag-${crypto.randomUUID()}`, category: 'ERRAND' },
  })
  const poster = await createUser({ name: 'Poster' })
  const taker = await createUser({ name: 'Taker' })
  const outsider = await createUser({ name: 'Outsider' })
  const admin = await createUser({ name: 'Admin', role: 'ADMIN' })
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
    data: { taskId: task.id, takerId: taker.id, status: 'ACCEPTED' },
  })
  const message = await prisma.message.create({
    data: { assignmentId: assignment.id, senderId: taker.id, content: 'photo of the boxes' },
  })
  return { poster, taker, outsider, admin, task, assignment, message }
}

const presignTask = (app, user, over = {}) =>
  request(app)
    .post(`${api}/files/presign`)
    .set(dev(user))
    .send({
      fileName: 'boxes.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
      taskId: over.taskId,
      messageId: over.messageId,
      ...over,
    })

const presignMessage = (app, user, messageId, over = {}) =>
  request(app)
    .post(`${api}/files/presign`)
    .set(dev(user))
    .send({
      fileName: 'note.txt',
      mimeType: 'text/plain',
      sizeBytes: 12,
      messageId,
      ...over,
    })

/* -------------------------------------------------------------------------- */

describe('POST /files/presign', () => {
  test('the task poster gets an Attachment row and a presigned PUT', async () => {
    const app = appWith()
    const { poster, task } = await seed()

    const res = await presignTask(app, poster, { taskId: task.id })
    expect(res.status).toBe(201)
    expect(res.body.expiresIn).toBe(300)
    expect(res.body.attachmentId).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.body.uploadUrl).toContain('/aubounty/attachments/')

    const row = await prisma.attachment.findUnique({ where: { id: res.body.attachmentId } })
    expect(row).toMatchObject({
      uploaderId: poster.id,
      taskId: task.id,
      messageId: null,
      fileName: 'boxes.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
    })
    expect(row.storageKey).toMatch(/^attachments\/[0-9a-f-]{36}\.png$/)
  })

  test('an admin may attach to a task they did not post', async () => {
    const app = appWith()
    const { admin, task } = await seed()
    expect((await presignTask(app, admin, { taskId: task.id })).status).toBe(201)
  })

  test('a non-poster cannot attach to a task', async () => {
    const app = appWith()
    const { taker, outsider, task } = await seed()
    expect((await presignTask(app, taker, { taskId: task.id })).status).toBe(403)
    expect((await presignTask(app, outsider, { taskId: task.id })).status).toBe(403)
    expect(await prisma.attachment.count()).toBe(0)
  })

  test('the message sender who is a thread participant may attach', async () => {
    const app = appWith()
    const { taker, message } = await seed()

    const res = await presignMessage(app, taker, message.id)
    expect(res.status).toBe(201)
    const row = await prisma.attachment.findUnique({ where: { id: res.body.attachmentId } })
    expect(row).toMatchObject({ messageId: message.id, taskId: null, uploaderId: taker.id })
    expect(row.storageKey).toMatch(/^attachments\/[0-9a-f-]{36}\.txt$/)
  })

  test('a participant may not attach to someone else\'s message', async () => {
    const app = appWith()
    const { poster, message } = await seed()
    // Poster is a participant but not the sender.
    expect((await presignMessage(app, poster, message.id)).status).toBe(403)
    expect(await prisma.attachment.count()).toBe(0)
  })

  test('a non-participant cannot attach to a message', async () => {
    const app = appWith()
    const { outsider, admin, message } = await seed()
    expect((await presignMessage(app, outsider, message.id)).status).toBe(403)
    expect((await presignMessage(app, admin, message.id)).status).toBe(403)
  })

  test('unknown parents are 404, not 403', async () => {
    const app = appWith()
    const { poster } = await seed()
    expect(
      (await presignTask(app, poster, { taskId: '00000000-0000-0000-0000-000000000000' })).status,
    ).toBe(404)
    expect(
      (
        await presignMessage(app, poster, '00000000-0000-0000-0000-000000000000')
      ).status,
    ).toBe(404)
  })

  test('mime type must be on the allowlist', async () => {
    const app = appWith()
    const { poster, task } = await seed()
    const bad = await request(app)
      .post(`${api}/files/presign`)
      .set(dev(poster))
      .send({ fileName: 'x.sh', mimeType: 'application/x-sh', sizeBytes: 10, taskId: task.id })
    expect(bad.status).toBe(400)
    expect(await prisma.attachment.count()).toBe(0)
  })

  test('sizeBytes must be 1..MAX_UPLOAD_MB MB', async () => {
    const app = appWith()
    const { poster, task } = await seed()
    const base = { fileName: 'a.pdf', mimeType: 'application/pdf', taskId: task.id }

    const zero = await request(app)
      .post(`${api}/files/presign`)
      .set(dev(poster))
      .send({ ...base, sizeBytes: 0 })
    expect(zero.status).toBe(400)

    const huge = await request(app)
      .post(`${api}/files/presign`)
      .set(dev(poster))
      .send({ ...base, sizeBytes: 10 * MB + 1 })
    expect(huge.status).toBe(400)

    const ceiling = await request(app)
      .post(`${api}/files/presign`)
      .set(dev(poster))
      .send({ ...base, sizeBytes: 10 * MB })
    expect(ceiling.status).toBe(201)
  })

  test('MAX_UPLOAD_MB is read from the environment', async () => {
    const app = appWith()
    const { poster, task } = await seed()
    const previous = process.env.MAX_UPLOAD_MB
    process.env.MAX_UPLOAD_MB = '1'
    try {
      const over = await request(app)
        .post(`${api}/files/presign`)
        .set(dev(poster))
        .send({ fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: MB + 1, taskId: task.id })
      expect(over.status).toBe(400)
      const edge = await request(app)
        .post(`${api}/files/presign`)
        .set(dev(poster))
        .send({ fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: MB, taskId: task.id })
      expect(edge.status).toBe(201)
    } finally {
      if (previous === undefined) delete process.env.MAX_UPLOAD_MB
      else process.env.MAX_UPLOAD_MB = previous
    }
  })

  test('exactly one parent, never both, never neither', async () => {
    const app = appWith()
    const { poster, task, message } = await seed()

    const neither = await request(app)
      .post(`${api}/files/presign`)
      .set(dev(poster))
      .send({ fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10 })
    expect(neither.status).toBe(400)

    const both = await request(app)
      .post(`${api}/files/presign`)
      .set(dev(poster))
      .send({ fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10, taskId: task.id, messageId: message.id })
    expect(both.status).toBe(400)
    expect(await prisma.attachment.count()).toBe(0)
  })

  test('unauthenticated callers are rejected', async () => {
    const app = appWith()
    const { task } = await seed()
    const res = await request(app)
      .post(`${api}/files/presign`)
      .send({ fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10, taskId: task.id })
    expect(res.status).toBe(401)
  })

  test('every repeat presign gets a fresh, unique storageKey', async () => {
    const app = appWith()
    const { poster, task } = await seed()
    const first = await presignTask(app, poster, { taskId: task.id, fileName: 'same.png' })
    const second = await presignTask(app, poster, { taskId: task.id, fileName: 'same.png' })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(first.body.attachmentId).not.toBe(second.body.attachmentId)
    expect(first.body.uploadUrl).not.toBe(second.body.uploadUrl)
    expect(await prisma.attachment.count({ where: { taskId: task.id } })).toBe(2)
    const keys = (
      await prisma.attachment.findMany({ where: { taskId: task.id }, select: { storageKey: true } })
    ).map((a) => a.storageKey)
    expect(new Set(keys).size).toBe(2)
  })

  test('an unconfigured store answers 503 and writes no row', async () => {
    const app = appWith()
    const { poster, task } = await seed()
    const previous = process.env.S3_BUCKET
    process.env.S3_BUCKET = ''
    try {
      const res = await presignTask(app, poster, { taskId: task.id })
      expect(res.status).toBe(503)
      expect(res.body.error.code).toBe('STORAGE_UNAVAILABLE')
      expect(await prisma.attachment.count()).toBe(0)
    } finally {
      process.env.S3_BUCKET = previous
    }
  })
})

/* -------------------------------------------------------------------------- */

describe('GET /files/:id/url', () => {
  async function taskAttachment() {
    const world = await seed()
    const app = appWith()
    const presigned = await presignTask(app, world.poster, { taskId: world.task.id })
    return { ...world, app, attachmentId: presigned.body.attachmentId }
  }

  async function messageAttachment() {
    const world = await seed()
    const app = appWith()
    const presigned = await presignMessage(app, world.taker, world.message.id)
    return { ...world, app, attachmentId: presigned.body.attachmentId }
  }

  test('any authenticated user may fetch a task attachment url', async () => {
    const { app, poster, taker, outsider, admin, attachmentId } = await taskAttachment()
    for (const user of [poster, taker, outsider, admin]) {
      const res = await request(app).get(`${api}/files/${attachmentId}/url`).set(dev(user))
      expect(res.status).toBe(200)
      expect(res.body.expiresIn).toBe(300)
      expect(res.body.url).toContain('/aubounty/attachments/')
    }
  })

  test('message attachment urls stay inside the thread', async () => {
    const { app, poster, taker, outsider, admin, attachmentId } = await messageAttachment()
    // The two participants (sender + counterpart) see it; nobody else does,
    // admins included: message files are the thread's business.
    for (const user of [taker, poster]) {
      expect((await request(app).get(`${api}/files/${attachmentId}/url`).set(dev(user))).status).toBe(200)
    }
    for (const user of [outsider, admin]) {
      expect((await request(app).get(`${api}/files/${attachmentId}/url`).set(dev(user))).status).toBe(403)
    }
  })

  test('anonymous callers and unknown ids', async () => {
    const { app, attachmentId } = await taskAttachment()
    expect((await request(app).get(`${api}/files/${attachmentId}/url`)).status).toBe(401)
    expect(
      (
        await request(app)
          .get(`${api}/files/00000000-0000-0000-0000-000000000000/url`)
          .set(dev(await createUser()))
      ).status,
    ).toBe(404)
  })
})

/* -------------------------------------------------------------------------- */

describe('DELETE /files/:id', () => {
  test('the uploader removes the row, others are refused', async () => {
    const world = await seed()
    const app = appWith()
    const presigned = await presignTask(app, world.poster, { taskId: world.task.id })
    const id = presigned.body.attachmentId

    expect((await request(app).delete(`${api}/files/${id}`).set(dev(world.taker))).status).toBe(403)
    expect((await request(app).delete(`${api}/files/${id}`).set(dev(world.outsider))).status).toBe(403)
    expect((await request(app).delete(`${api}/files/${id}`)).status).toBe(401)
    expect(await prisma.attachment.count()).toBe(1)

    const mine = await request(app).delete(`${api}/files/${id}`).set(dev(world.poster))
    expect(mine.status).toBe(204)
    expect(await prisma.attachment.count()).toBe(0)

    expect((await request(app).delete(`${api}/files/${id}`).set(dev(world.poster))).status).toBe(404)
  })

  test('an admin may remove anyone\'s attachment', async () => {
    const world = await seed()
    const app = appWith()
    const presigned = await presignTask(app, world.poster, { taskId: world.task.id })
    const res = await request(app)
      .delete(`${api}/files/${presigned.body.attachmentId}`)
      .set('Cookie', await sessionCookie(world.admin))
    expect(res.status).toBe(204)
    expect(await prisma.attachment.count()).toBe(0)
  })

  test('an unknown id is 404, not 401-driven', async () => {
    const app = appWith()
    expect(
      (
        await request(app)
          .delete(`${api}/files/00000000-0000-0000-0000-000000000000`)
          .set(dev(await createUser()))
      ).status,
    ).toBe(404)
  })
})

/* -------------------------------------------------------------------------- */

describe('attachment serialization', () => {
  test('task detail carries attachments with metadata only', async () => {
    const world = await seed()
    const app = appWith()
    const presigned = await presignTask(app, world.poster, {
      taskId: world.task.id,
      fileName: 'proof.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 5 * MB,
    })

    const res = await request(app).get(`${api}/tasks/${world.task.id}`)
    expect(res.status).toBe(200)
    expect(res.body.task.attachments).toHaveLength(1)
    const [attachment] = res.body.task.attachments
    expect(Object.keys(attachment).sort()).toEqual(ATTACHMENT_FIELDS.slice().sort())
    expect(attachment).toMatchObject({
      id: presigned.body.attachmentId,
      fileName: 'proof.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 5 * MB,
    })
    // Bytes and keys never leak through the API.
    expect(JSON.stringify(res.body)).not.toContain('storageKey')
    expect(JSON.stringify(res.body)).not.toContain('uploaderId')
  })

  test('message history carries attachments for their own message', async () => {
    const world = await seed()
    const app = appWith()
    await presignMessage(app, world.taker, world.message.id, { fileName: 'note.txt' })
    await presignMessage(app, world.taker, world.message.id, { fileName: 'note2.txt' })
    await prisma.message.create({
      data: { assignmentId: world.assignment.id, senderId: world.taker.id, content: 'no files' },
    })

    const res = await request(app)
      .get(`${api}/assignments/${world.assignment.id}/messages`)
      .set(dev(world.poster))
    expect(res.status).toBe(200)
    const [withFiles, bare] = res.body.messages
    expect(bare.attachments).toEqual([])
    expect(withFiles.attachments).toHaveLength(2)
    expect(Object.keys(withFiles.attachments[0]).sort()).toEqual(ATTACHMENT_FIELDS.slice().sort())
    expect(withFiles.attachments.map((a) => a.fileName)).toEqual(['note.txt', 'note2.txt'])
  })
})

/* -------------------------------------------------------------------------- */

// Real MinIO round-trip: `AUBOUNTY_TEST_S3=1` with the compose stack up and
// the aubounty/aubounty credentials in the S3_* env (dev .env has them).
// Note: the stock presigner signs only the host header, so a mismatched
// Content-Type on the PUT cannot be rejected by the store; hence no test
// for that here.
describe.skipIf(!liveS3)('live MinIO round-trip', () => {
  test('presigned PUT stores, GET returns the bytes, DELETE removes them', async () => {
    const world = await seed()
    const app = appWith()
    const presigned = await presignMessage(app, world.taker, world.message.id, {
      fileName: 'live.txt',
      mimeType: 'text/plain',
      sizeBytes: 27,
    })
    expect(presigned.status).toBe(201)
    const body = 'round trip through minio\n'

    const put = await fetch(presigned.body.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body,
    })
    expect(put.ok).toBe(true)

    const link = await request(app)
      .get(`${api}/files/${presigned.body.attachmentId}/url`)
      .set(dev(world.poster))
    expect(link.status).toBe(200)
    const got = await fetch(link.body.url)
    expect(got.ok).toBe(true)
    expect(await got.text()).toBe(body)
    expect(got.headers.get('content-type')).toContain('text/plain')
    expect(got.headers.get('content-disposition')).toContain('live.txt')

    // Deleting the attachment eventually removes the stored object too: grab a
    // GET url for the already-uploaded object first, then drop the row.
    const survivorUrl = (
      await request(app)
        .get(`${api}/files/${presigned.body.attachmentId}/url`)
        .set(dev(world.taker))
    ).body.url
    expect((await fetch(survivorUrl)).ok).toBe(true)

    const del = await request(app)
      .delete(`${api}/files/${presigned.body.attachmentId}`)
      .set(dev(world.taker))
    expect(del.status).toBe(204)
    await new Promise((r) => setTimeout(r, 500)) // S3 delete is best-effort async
    expect((await fetch(survivorUrl)).status).toBe(404)
  })
})
