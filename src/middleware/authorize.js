import { forbidden, unauthorized } from '../lib/errors.js'

export const isAdmin = (user) => user?.role === 'ADMIN'
export const isTeacher = (user) => user?.role === 'TEACHER'

/** Post an Event: org members, teachers and admins only (Proposal v8, section 5). */
export const canPostEvent = (user) =>
  Boolean(user) && (user.isOrgMember || isTeacher(user) || isAdmin(user))

/** Offer extra credit as a reward: teachers and admins only. */
export const canOfferExtraCredit = (user) => isTeacher(user) || isAdmin(user)

/** You can edit, cancel and manage applicants on your own posts. Admins moderate anything. */
export const ownsTask = (user, task) => task.posterId === user.id || isAdmin(user)

/**
 * Show the rotating check-in code and validate attendance (RBAC matrix row):
 * the poster (a teacher's own events are covered here), members of the
 * sponsoring org, and admins. Teachers do not get other people's events.
 */
export const canManageCheckin = (user, task) =>
  Boolean(user) &&
  (ownsTask(user, task) || (task.orgId != null && user.orgIds?.includes(task.orgId)))

export const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user) return next(unauthorized())
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`This action needs one of: ${roles.join(', ')}.`))
    }
    next()
  }
