import { Server } from 'socket.io'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { parseCookies } from '../auth/cookies.js'
import { TOKEN_COOKIE, verifySessionToken } from '../auth/session.js'
import { userFromPayload } from '../middleware/auth.js'
import { setIo } from './io.js'

const SOCKET_PATH = '/aubounty/socket.io'

/**
 * D2 realtime. Socket.io rides on the existing HTTP server (same port as the
 * API) under its own path, with the same CORS list. REST remains the source of
 * truth; this gateway only authenticates, rooms and fans out.
 */

/** Same handshake identity rules as the API: cookie first, dev header in dev. */
async function resolveHandshakeUser(handshake) {
  const token = parseCookies(handshake.headers.cookie)[TOKEN_COOKIE]
  if (token) {
    const payload = await verifySessionToken(token)
    if (payload?.sub && payload.role) return userFromPayload(payload)
  }

  if (process.env.DEV_AUTH === '1') {
    const id = handshake.headers['x-dev-user-id']
    if (id) {
      const user = await prisma.user.findUnique({
        where: { id },
        include: { memberships: true },
      })
      if (user) {
        return {
          id: user.id,
          role: user.role,
          name: user.name,
          orgIds: user.memberships.map((m) => m.orgId),
          isOrgMember: user.memberships.length > 0,
        }
      }
    }
  }
  return null
}

const subscribePayload = z
  .object({
    taskId: z.uuid().optional(),
    assignmentId: z.uuid().optional(),
  })
  .refine((p) => Boolean(p.taskId) !== Boolean(p.assignmentId), {
    message: 'Give exactly one of taskId or assignmentId.',
  })

/**
 * Decides whether the socket's user may enter a room, and what that room is.
 * Tasks are public to any authenticated user; an assignment thread is only for
 * its two participants.
 */
async function roomFor(user, payload) {
  if (payload.taskId) {
    const task = await prisma.task.findUnique({ where: { id: payload.taskId }, select: { id: true } })
    if (!task) return { error: 'not_found' }
    return { room: `task:${task.id}` }
  }

  const assignment = await prisma.taskAssignment.findUnique({
    where: { id: payload.assignmentId },
    select: { id: true, takerId: true, task: { select: { posterId: true } } },
  })
  if (!assignment) return { error: 'not_found' }
  const isParticipant = assignment.takerId === user.id || assignment.task.posterId === user.id
  if (!isParticipant) return { error: 'forbidden' }
  return { room: `assignment:${assignment.id}` }
}

function makeToggle(socket, subscribe) {
  return async (payload, ack) => {
    const parsed = subscribePayload.safeParse(payload ?? {})
    if (!parsed.success) {
      ack?.({ ok: false, error: 'bad_request' })
      return
    }

    const { room, error } = await roomFor(socket.data.user, parsed.data)
    if (error) {
      ack?.({ ok: false, error })
      return
    }

    if (subscribe) socket.join(room)
    else socket.leave(room)
    ack?.({ ok: true, room })
  }
}

export function attachSockets(httpServer) {
  const io = new Server(httpServer, {
    path: SOCKET_PATH,
    cors: {
      origin: process.env.CORS_ORIGIN?.split(',') ?? true,
      credentials: true,
      allowedHeaders: ['Content-Type', 'x-dev-user-id'],
    },
  })

  io.use(async (socket, next) => {
    try {
      const user = await resolveHandshakeUser(socket.handshake)
      if (!user) return next(new Error('unauthorized'))
      socket.data.user = user
      next()
    } catch (err) {
      next(err)
    }
  })

  io.on('connection', (socket) => {
    const { id } = socket.data.user
    socket.join(`user:${id}`)
    socket.join('emergencies')

    socket.on('subscribe', makeToggle(socket, true))
    socket.on('unsubscribe', makeToggle(socket, false))
  })

  setIo(io)
  return io
}
