import { HOLDS_A_SPOT } from '../services/settle.js'

export const userCard = (u) =>
  u && { id: u.id, name: u.name, role: u.role, universityId: u.universityId ?? null }

export const taskInclude = {
  poster: { select: { id: true, name: true, role: true, universityId: true } },
  org: { select: { id: true, name: true } },
  tags: { include: { tag: true } },
  assignments: {
    include: { taker: { select: { id: true, name: true, role: true, universityId: true } } },
    orderBy: { appliedAt: 'asc' },
  },
}

export function serializeTask(task, viewer, { withApplicants = false } = {}) {
  const taken = task.assignments.filter((a) => HOLDS_A_SPOT.includes(a.status))
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
    maxTakers: task.maxTakers,
    takenCount: taken.length,
    spotsLeft: Math.max(0, task.maxTakers - taken.length),
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
      taker: userCard(a.taker),
    }))
  }
  return out
}
