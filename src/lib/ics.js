/**
 * Hand-rolled iCalendar (RFC 5545) output for an event task. A string template,
 * not a library: the file only ever carries one VEVENT, so the whole job is
 * correct TEXT escaping, UTC timestamps and 75-octet line folding.
 */

/** RFC 5545 TEXT escaping: backslash first, then the two specials, then breaks. */
export function escapeText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n/g, '\\n')
    .replace(/[\r\n]/g, '\\n')
}

/** YYYYMMDDTHHMMSSZ — every date we emit is UTC. */
export function icsDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/**
 * Splits one logical line into physical lines of at most 75 octets; folded
 * continuations start with a single space. Never splits a multi-byte character.
 */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line
  const parts = []
  let start = 0
  while (start < bytes.length) {
    const budget = start === 0 ? 75 : 74 // the space costs one octet
    let end = Math.min(start + budget, bytes.length)
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    parts.push((start === 0 ? '' : ' ') + bytes.subarray(start, end).toString('utf8'))
    start = end
  }
  return parts.join('\r\n')
}

const line = (name, value) => `${name}:${escapeText(value)}`

/**
 * The calendar file for one event task. Returns null when the task has neither
 * startsAt nor deadline, so the route can answer 400 instead of guessing dates.
 */
export function icsForTask(task, now = new Date()) {
  const start = task.startsAt ?? task.deadline
  if (!start) return null
  const end = task.deadline && task.deadline > start ? task.deadline : new Date(start.getTime() + 2 * 60 * 60 * 1000)

  const rows = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AU Bounty//campus bounty board//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:task-${task.id}@aubounty`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    line('SUMMARY', task.title),
  ]
  if (task.locationName) rows.push(line('LOCATION', task.locationName))
  rows.push(line('DESCRIPTION', task.content.slice(0, 1000)))
  rows.push('END:VEVENT', 'END:VCALENDAR')

  return rows.map(fold).join('\r\n') + '\r\n'
}
