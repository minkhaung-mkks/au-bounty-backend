import { prisma } from './prisma.js'

const RESEND_URL = 'https://api.resend.com/emails'
const RESEND_TIMEOUT_MS = 10_000
// A failed send stays queued and the scheduler retries it, but never one that a
// request handler may still be mid-flight on.
const RETRY_MIN_AGE_MS = 60_000
const RETRY_BATCH = 20

/**
 * D8 email half. Every outbound notification is an outbox row first: the
 * unique (kind, refId) constraint is the dedupe (one email per trigger, ever),
 * and sentAt flips only after a transport accepted it. Retry semantics: a row
 * with sentAt null is retried by the mail scheduler on every pass (at most
 * RETRY_BATCH rows, each at least a minute old); there is no cap or dead-letter
 * — a permanently failing transport keeps retrying, which is the right failure
 * mode for a campus tool with a console fallback.
 *
 * Nothing in this module throws: a mail problem must never fail an API request.
 */

/** Insert the outbox row. Returns null when this trigger already fired. */
export async function queueEmail({ kind, refId, to, subject, body }) {
  try {
    return await prisma.emailOutbox.create({
      data: { kind, refId, toEmail: to, subject, body },
    })
  } catch (err) {
    if (err?.code === 'P2002') return null // already queued or sent
    throw err
  }
}

/** Attempt delivery of one row through the configured transport. */
export async function deliverEmail(row) {
  const ok = await runTransport(row.toEmail, row.subject, row.body)
  if (ok) {
    await prisma.emailOutbox.update({
      where: { id: row.id },
      data: { sentAt: new Date() },
    })
  }
  return ok
}

/**
 * Queue then deliver. Returns 'sent' (transport accepted, sentAt set),
 * 'queued' (row recorded, transport failed, scheduler will retry), 'deduped'
 * (the trigger already fired), or 'failed' (even the insert failed).
 */
export async function sendEmail({ kind, refId, to, subject, body }) {
  let row
  try {
    row = await queueEmail({ kind, refId, to, subject, body })
  } catch (err) {
    console.warn(`mail ${kind} for ${refId} could not be queued: ${err.message}`)
    return 'failed'
  }
  if (!row) return 'deduped'
  try {
    return (await deliverEmail(row)) ? 'sent' : 'queued'
  } catch (err) {
    console.warn(`mail ${kind} for ${refId} failed to send: ${err.message}`)
    return 'queued'
  }
}

/** Scheduler entry point: retry everything still unsent, oldest first. */
export async function retryUnsentEmails() {
  const pending = await prisma.emailOutbox.findMany({
    where: { sentAt: null, createdAt: { lte: new Date(Date.now() - RETRY_MIN_AGE_MS) } },
    orderBy: { createdAt: 'asc' },
    take: RETRY_BATCH,
  })
  let sent = 0
  for (const row of pending) {
    try {
      if (await deliverEmail(row)) sent += 1
    } catch (err) {
      console.warn(`mail retry of ${row.kind}/${row.refId} failed: ${err.message}`)
    }
  }
  return sent
}

/**
 * `console` (default) logs the email and counts it as sent — the dev/demo
 * transport still exercises the outbox. `resend` POSTs to the Resend API with
 * a 10s timeout; any non-2xx, network error or timeout leaves the row queued.
 */
async function runTransport(to, subject, body) {
  const mode = process.env.MAIL_TRANSPORT ?? 'console'
  if (mode !== 'resend') {
    console.log(`[mail] to=${to} subject="${subject}"\n${body}\n`)
    return true
  }

  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.MAIL_FROM
  if (!apiKey || !from) {
    console.warn('resend transport selected but RESEND_API_KEY / MAIL_FROM is unset; email stays queued')
    return false
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS)
  try {
    const response = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, text: body }),
      signal: controller.signal,
    })
    await response.text() // drain for keep-alive
    if (!response.ok) {
      console.warn(`resend answered ${response.status} for "${subject}"; left queued`)
      return false
    }
    return true
  } catch (err) {
    console.warn(`resend send of "${subject}" failed: ${err.message}`)
    return false
  } finally {
    clearTimeout(timeout)
  }
}
