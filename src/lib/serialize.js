import { occupancy } from './occupancy.js'

export const userCard = (u) =>
  u && { id: u.id, name: u.name, role: u.role, universityId: u.universityId ?? null }

/** Attachment metadata; file bytes move over presigned URLs, never here. */
export const serializeAttachment = (a) => ({
  id: a.id,
  fileName: a.fileName,
  mimeType: a.mimeType,
  sizeBytes: a.sizeBytes,
  createdAt: a.createdAt,
})

export const taskInclude = {
  poster: { select: { id: true, name: true, role: true, universityId: true } },
  org: { select: { id: true, name: true } },
  tags: { include: { tag: true } },
  assignments: {
    include: { taker: { select: { id: true, name: true, role: true, universityId: true } } },
    orderBy: { appliedAt: 'asc' },
  },
  attachments: { orderBy: { createdAt: 'asc' } },
}

/** Every field the Message model has, nothing more. */
export const serializeMessage = (m) => ({
  id: m.id,
  assignmentId: m.assignmentId,
  senderId: m.senderId,
  content: m.content,
  createdAt: m.createdAt,
  readAt: m.readAt ?? null,
  // Only populated when the query included the message's own attachments.
  attachments: (m.attachments ?? []).map(serializeAttachment),
})

export function serializeTask(task, viewer, { withApplicants = false } = {}) {
  const { takenCount, spotsLeft } = occupancy(task)
  const mine = viewer ? task.assignments.find((a) => a.takerId === viewer.id) : null
  const isOwner = Boolean(viewer) && task.posterId === viewer.id

  const out = {
    id: task.id,
    title: task.title,
    content: task.content,
    type: task.type,
    status: task.status,
    acceptanceMode: task.acceptanceMode,
    createdAt: task.createdAt,
    startsAt: task.startsAt,
    deadline: task.deadline,
    externalRef: task.externalRef,
    reward: { type: task.rewardType, description: task.rewardDescription },
    location: { name: task.locationName, lat: task.locationLat, lng: task.locationLng },
    poster: userCard(task.poster),
    org: task.org ?? null,
    tags: task.tags.map((t) => ({ id: t.tag.id, name: t.tag.name, category: t.tag.category })),
    attachments: (task.attachments ?? []).map(serializeAttachment),
    maxTakers: task.maxTakers,
    takenCount,
    spotsLeft,
    isMine: isOwner,
    myAssignment: mine
      ? { id: mine.id, status: mine.status, completionRequestedAt: mine.completionRequestedAt }
      : null,
  }

  // Applicant identities are only the poster's (or an admin's) business.
  if (withApplicants) {
    out.assignments = task.assignments.map((a) => ({
      id: a.id,
      status: a.status,
      appliedAt: a.appliedAt,
      completionRequestedAt: a.completionRequestedAt,
      completedAt: a.completedAt,
      // Event attendance stamps: who checked in and when.
      checkedInAt: a.checkedInAt ?? null,
      checkedInBy: a.checkedInBy ?? null,
      taker: userCard(a.taker),
    }))
  }
  return out
}
