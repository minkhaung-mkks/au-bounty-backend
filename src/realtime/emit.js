import { prisma } from '../lib/prisma.js'
import { occupancy } from '../lib/occupancy.js'
import { getIo } from './io.js'

/**
 * Server-to-client fan-out. REST stays the source of truth; every emit here is
 * best-effort and must never fail the request that triggered it, so each one
 * swallows (and logs) its own errors.
 */

/** Fans out the current status/occupancy of a task to its detail room. */
export async function emitTaskUpdated(taskId) {
  const io = getIo()
  if (!io) return
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, status: true, maxTakers: true, assignments: { select: { status: true } } },
    })
    if (!task) return
    const { takenCount, spotsLeft } = occupancy(task)
    io.to(`task:${task.id}`).emit('task:updated', {
      taskId: task.id,
      status: task.status,
      takenCount,
      spotsLeft,
    })
  } catch (err) {
    console.error('emit task:updated failed:', err)
  }
}

/**
 * The single hook for task creation. Every path that creates a task (the REST
 * route today, the peer inbound endpoint later) calls this, so an EMERGENCY
 * broadcast can never be forgotten by a new creation point.
 */
export function emitTaskCreated(task) {
  const io = getIo()
  if (!io) return
  try {
    const { takenCount, spotsLeft } = occupancy({ ...task, assignments: task.assignments ?? [] })
    io.to(`task:${task.id}`).emit('task:updated', {
      taskId: task.id,
      status: task.status,
      takenCount,
      spotsLeft,
    })
    if (task.type === 'EMERGENCY') {
      io.to('emergencies').emit('emergency:new', {
        taskId: task.id,
        title: task.title,
        locationName: task.locationName,
        createdAt: task.createdAt,
      })
    }
  } catch (err) {
    console.error('emit task creation events failed:', err)
  }
}

/**
 * A new chat message: the full row to the thread room, and a lightweight nudge
 * (just the assignmentId) to the counterpart's personal room so a closed chat
 * can badge without loading anything.
 */
export function emitMessageNew(message, counterpartId) {
  const io = getIo()
  if (!io) return
  try {
    io.to(`assignment:${message.assignmentId}`).emit('message:new', { message })
    if (counterpartId) io.to(`user:${counterpartId}`).emit('message:new', { assignmentId: message.assignmentId })
  } catch (err) {
    console.error('emit message:new failed:', err)
  }
}

/** The reader caught up to untilMessageId; the sender uses it to tick the row. */
export function emitMessageRead({ assignmentId, readerId, untilMessageId }) {
  const io = getIo()
  if (!io) return
  try {
    io.to(`assignment:${assignmentId}`).emit('message:read', { assignmentId, readerId, untilMessageId })
  } catch (err) {
    console.error('emit message:read failed:', err)
  }
}
