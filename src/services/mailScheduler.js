import { prisma } from '../lib/prisma.js'
import { sendEmail, retryUnsentEmails } from '../lib/mailer.js'
import { AUTO_CONFIRM_DAYS } from './settle.js'

export const MAIL_INTERVAL_MS = 60_000
/** An event this close to starting is "starting now" for reminder purposes. */
export const EVENT_REMINDER_WINDOW_MS = 60 * 60 * 1000
/** Days of silence before the poster gets the "confirm or it auto-confirms" nudge. */
export const CONFIRM_WARNING_AFTER_DAYS = 5

const days = (n) => n * 24 * 60 * 60 * 1000

/**
 * D8 trigger half: the three notification emails, all deduped by the outbox's
 * (kind, refId) constraint. One function is called inline by the completion
 * route; the two scans run from the scheduler loop (same start/stop shape as
 * the alert sweeper: immediate pass, then every MAIL_INTERVAL_MS, re-entrancy
 * guarded, timer unref'd so the HTTP server owns process lifetime).
 */

const fmt = (date) =>
  new Date(date).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  })

/** Taker marked work done: the poster must now confirm (or wait out the window). */
export function notifyCompletionRequested(assignment) {
  const { task, taker } = assignment
  const poster = task.poster
  const autoConfirmAt = new Date(assignment.completionRequestedAt.getTime() + days(AUTO_CONFIRM_DAYS))
  return sendEmail({
    kind: 'COMPLETION_REQUESTED',
    refId: assignment.id,
    to: poster.email,
    subject: `AU Bounty: ${taker.name} marked "${task.title}" done - please confirm`,
    body: [
      `Hi ${poster.name},`,
      '',
      `${taker.name} marked "${task.title}" as done. Open AU Bounty and confirm the work, or reply to the taker if something is off.`,
      '',
      `If you do nothing, the assignment is confirmed automatically after ${AUTO_CONFIRM_DAYS} days (${fmt(autoConfirmAt)}).`,
      '',
      'AU Bounty',
    ].join('\n'),
  })
}

/**
 * CONFIRM_WARNING: a PENDING_CONFIRMATION whose completionRequestedAt is
 * between 5 and 7 days old has ~2 days left before settle() auto-confirms it.
 */
export async function sendConfirmWarnings() {
  const now = Date.now()
  const due = await prisma.taskAssignment.findMany({
    where: {
      status: 'PENDING_CONFIRMATION',
      completionRequestedAt: {
        lte: new Date(now - days(CONFIRM_WARNING_AFTER_DAYS)),
        gte: new Date(now - days(AUTO_CONFIRM_DAYS)),
      },
    },
    include: { task: { include: { poster: true } }, taker: true },
    orderBy: { completionRequestedAt: 'asc' },
  })

  let sent = 0
  for (const a of due) {
    const result = await sendEmail({
      kind: 'CONFIRM_WARNING',
      refId: a.id,
      to: a.task.poster.email,
      subject: `AU Bounty: 2 days left to confirm "${a.task.title}"`,
      body: [
        `Hi ${a.task.poster.name},`,
        '',
        `${a.taker.name} marked "${a.task.title}" as done on ${fmt(a.completionRequestedAt)} and you have not confirmed yet.`,
        `It is confirmed automatically in about 2 days (${fmt(new Date(a.completionRequestedAt.getTime() + days(AUTO_CONFIRM_DAYS)))}). Open AU Bounty to confirm it yourself.`,
        '',
        'AU Bounty',
      ].join('\n'),
    })
    if (result !== 'deduped') sent += 1
  }
  return sent
}

/**
 * EVENT_REMINDER: every ACCEPTED assignment on an event starting within the
 * next hour (and still in the future) gets one reminder, per taker. Status is
 * deliberately not filtered beyond "not cancelled": an event whose spots are
 * full is LOCKED long before it starts.
 */
export async function sendEventReminders() {
  const now = new Date()
  const events = await prisma.task.findMany({
    where: {
      type: 'EVENT',
      status: { not: 'CANCELLED' },
      startsAt: { gte: now, lte: new Date(now.getTime() + EVENT_REMINDER_WINDOW_MS) },
    },
    select: {
      id: true,
      title: true,
      startsAt: true,
      locationName: true,
      assignments: {
        where: { status: 'ACCEPTED' },
        include: { taker: true },
        orderBy: { appliedAt: 'asc' },
      },
    },
    orderBy: { startsAt: 'asc' },
  })

  let sent = 0
  for (const event of events) {
    for (const a of event.assignments) {
      const result = await sendEmail({
        kind: 'EVENT_REMINDER',
        refId: a.id,
        to: a.taker.email,
        subject: `AU Bounty: "${event.title}" starts soon`,
        body: [
          `Hi ${a.taker.name},`,
          '',
          `"${event.title}" starts at ${fmt(event.startsAt)}${event.locationName ? ` (${event.locationName})` : ''}. Don't forget to check in with the code at the venue.`,
          '',
          'AU Bounty',
        ].join('\n'),
      })
      if (result !== 'deduped') sent += 1
    }
  }
  return sent
}

/** One scheduler pass: retry what failed, then run both time-window scans. */
export async function runMailPass() {
  await retryUnsentEmails()
  await sendConfirmWarnings()
  await sendEventReminders()
}

let timer = null
let running = false

async function tick() {
  if (running) return // a slow pass must not stack on itself
  running = true
  try {
    await runMailPass()
  } catch (err) {
    console.warn('mail pass failed:', err.message)
  } finally {
    running = false
  }
}

/** Runs an immediate pass, then every MAIL_INTERVAL_MS. Safe to call twice. */
export function startMailScheduler() {
  if (timer) return
  tick()
  timer = setInterval(tick, MAIL_INTERVAL_MS)
  timer.unref?.() // the HTTP server owns the process lifetime, not this loop
}

export function stopMailScheduler() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
