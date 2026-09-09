/**
 * AU directory conventions, applied to the sign-in address.
 *
 * Student accounts are u<7 digits>@au.edu, so the student id is already part
 * of the address and never needs to be typed on the profile form. Every other
 * @au.edu address belongs to staff, which is the only role signal the id_token
 * carries when the tenant publishes no employeeId claim.
 *
 * Anything outside the tenant (including the synthetic
 * <oid>@unset.au-bounty.invalid fallback) tells us nothing, so it keeps the
 * schema default: STUDENT, no id, form shown as before.
 */
const STUDENT_EMAIL = /^u(\d{7})@au\.edu$/i

export function identityFromEmail(email) {
  const address = String(email ?? '').trim().toLowerCase()

  const student = STUDENT_EMAIL.exec(address)
  if (student) return { universityId: student[1], role: 'STUDENT' }

  if (address.endsWith('@au.edu')) return { universityId: null, role: 'TEACHER' }

  return { universityId: null, role: 'STUDENT' }
}
