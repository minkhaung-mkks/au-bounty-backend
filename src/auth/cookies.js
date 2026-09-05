/**
 * Minimal RFC 6265 cookie header parser. cookie-parser is a whole dependency
 * for something this small, and D2's socket.io handshake needs the same
 * parsing, so it lives here as one shared helper.
 */
export function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    const raw = part.slice(eq + 1).trim()
    try {
      out[name] = decodeURIComponent(raw)
    } catch {
      out[name] = raw
    }
  }
  return out
}
