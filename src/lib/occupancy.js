/**
 * Task occupancy in one place. Kept dependency-free (no prisma, no realtime)
 * so settle, serialization and the socket emitters can all import it without
 * forming an import cycle: services/settle.js -> realtime/emit.js -> here.
 */

/** Assignment states that occupy one of the task's spots. */
export const HOLDS_A_SPOT = ['ACCEPTED', 'IN_PROGRESS', 'PENDING_CONFIRMATION', 'COMPLETED']

export function occupancy(task) {
  const taken = task.assignments.filter((a) => HOLDS_A_SPOT.includes(a.status)).length
  return { takenCount: taken, spotsLeft: Math.max(0, task.maxTakers - taken) }
}
