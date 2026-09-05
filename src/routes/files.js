import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { validate } from '../middleware/validate.js'
import { requireUser } from '../middleware/auth.js'
import { isAdmin, ownsTask } from '../middleware/authorize.js'
import { badRequest, forbidden, notFound } from '../lib/errors.js'
import { fileStore, storageKeyFor } from '../lib/filestore.js'

/**
 * D5 attachments. The API never proxies file bytes: it validates, records an
 * Attachment row and hands out presigned PUT/GET URLs; the client talks to the
 * store directly with a signature that pins the content type and expires fast.
 */

export const filesRouter = Router()

const URL_TTL_SECONDS = 300

// The only content types accepted, with the storage-key extension each maps to.
const MIME_TYPES = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'text/plain': 'txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
}

const maxUploadBytes = () => Number(process.env.MAX_UPLOAD_MB || 10) * 1024 * 1024

const idParam = z.object({ id: z.uuid() })

const presignBody = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.enum(Object.keys(MIME_TYPES)),
    sizeBytes: z.number().int(),
    taskId: z.uuid().optional(),
    messageId: z.uuid().optional(),
  })
  .superRefine((body, ctx) => {
    // An attachment belongs to exactly one parent; the check constraint in the
    // db says the same, this keeps the error friendly.
    if (Boolean(body.taskId) === Boolean(body.messageId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['taskId'],
        message: 'Attach to exactly one task or message.',
      })
    }
    if (body.sizeBytes !== undefined) {
      if (body.sizeBytes < 1) {
        ctx.addIssue({ code: 'custom', path: ['sizeBytes'], message: 'Files cannot be empty.' })
      } else if (body.sizeBytes > maxUploadBytes()) {
        ctx.addIssue({
          code: 'custom',
          path: ['sizeBytes'],
          message: `Files can be at most ${process.env.MAX_UPLOAD_MB || 10} MB.`,
        })
      }
    }
  })

/** The assignment a message lives in, with the ids that decide participation. */
const messageThreadInclude = {
  assignment: { include: { task: { select: { posterId: true } } } },
}

/* ------------------------------------------------------------------ presign */

filesRouter.post(
  '/files/presign',
  requireUser,
  validate({ body: presignBody }),
  async (req, res) => {
    const { fileName, mimeType, sizeBytes, taskId, messageId } = req.valid.body
    const me = req.user

    // Parent ownership first: no Attachment row may exist for a request that
    // is about to be refused.
    let parent
    if (taskId) {
      const task = await prisma.task.findUnique({ where: { id: taskId } })
      if (!task) throw notFound('No task with that id.')
      if (!ownsTask(me, task)) throw forbidden('Only the task poster can attach files to it.')
      parent = { taskId }
    } else {
      const message = await prisma.message.findUnique({
        where: { id: messageId },
        include: messageThreadInclude,
      })
      if (!message) throw notFound('No message with that id.')
      const thread = message.assignment
      const isParticipant = thread.takerId === me.id || thread.task.posterId === me.id
      if (!isParticipant) throw forbidden('Only the two participants can attach files here.')
      if (message.senderId !== me.id) {
        throw forbidden('You can only attach files to your own messages.')
      }
      parent = { messageId }
    }

    const storageKey = storageKeyFor(MIME_TYPES[mimeType])
    // Sign before writing the row: an unconfigured/unreachable store must not
    // leave orphan Attachment records behind.
    const uploadUrl = await fileStore.presignPut(storageKey, mimeType, URL_TTL_SECONDS)
    const attachment = await prisma.attachment.create({
      data: { uploaderId: me.id, ...parent, storageKey, fileName, mimeType, sizeBytes },
    })

    res.status(201).json({
      attachmentId: attachment.id,
      uploadUrl,
      expiresIn: URL_TTL_SECONDS,
    })
  },
)

/* -------------------------------------------------------------- download url */

filesRouter.get('/files/:id/url', requireUser, validate({ params: idParam }), async (req, res) => {
  const me = req.user
  const attachment = await prisma.attachment.findUnique({
    where: { id: req.valid.params.id },
    include: {
      task: { select: { id: true } },
      message: { include: messageThreadInclude },
    },
  })
  if (!attachment) throw notFound('No attachment with that id.')

  // Task attachments follow task visibility: every authenticated user sees the
  // board, so every authenticated user may fetch the download link. Message
  // attachments stay inside the two-person thread.
  if (attachment.messageId) {
    const thread = attachment.message.assignment
    const isParticipant = thread.takerId === me.id || thread.task.posterId === me.id
    if (!isParticipant) throw forbidden('Only the two participants can open this file.')
  }

  const url = await fileStore.presignGet(attachment.storageKey, URL_TTL_SECONDS, {
    fileName: attachment.fileName,
  })
  res.json({ url, expiresIn: URL_TTL_SECONDS })
})

/* -------------------------------------------------------------------- delete */

filesRouter.delete('/files/:id', requireUser, validate({ params: idParam }), async (req, res) => {
  const me = req.user
  const attachment = await prisma.attachment.findUnique({
    where: { id: req.valid.params.id },
    select: { id: true, storageKey: true, uploaderId: true },
  })
  if (!attachment) throw notFound('No attachment with that id.')
  if (attachment.uploaderId !== me.id && !isAdmin(me)) {
    throw forbidden('Only the uploader can remove this file.')
  }

  await prisma.attachment.delete({ where: { id: attachment.id } })
  // The row is gone; the stored object follows on a best-effort basis.
  fileStore.deleteObject(attachment.storageKey).catch(() => {})
  res.status(204).end()
})
