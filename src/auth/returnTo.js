/**
 * Open-redirect guard for the auth flow's returnTo parameter.
 *
 * Only same-site relative paths ("/tasks/42", "/aubounty/profile") may ride
 * through the OAuth state and become the post-login redirect. Absolute URLs,
 * protocol-relative URLs (//evil.com), and backslash tricks all fall back to
 * the site root.
 */
export function safeReturnPath(raw) {
  if (typeof raw !== 'string' || raw === '') return '/'
  if (!raw.startsWith('/')) return '/'
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  if (/[\r\n]/.test(raw)) return '/'
  return raw
}

/**
 * The OAuth state blob, base64url-encoded. It carries the sanitized returnTo
 * (`r`) and the login CSRF nonce (`n`) that must match the nonce cookie
 * /auth/login set alongside it.
 */
export function encodeState(returnTo, nonce) {
  const payload = JSON.stringify({ r: safeReturnPath(returnTo), n: nonce ?? null })
  return Buffer.from(payload, 'utf8').toString('base64url')
}

export function decodeState(state) {
  try {
    const { r, n } = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'))
    return {
      returnTo: safeReturnPath(r),
      nonce: typeof n === 'string' && n.length > 0 ? n : null,
    }
  } catch {
    return { returnTo: '/', nonce: null }
  }
}

/**
 * Final post-login destination. In production the SPA is same-origin, so the
 * bare relative path is right. In dev the SPA lives on the vite origin while
 * the API runs on its own port, so APP_ORIGIN (when set) is prepended. The
 * returnTo path stays sanitized either way; APP_ORIGIN itself must be a plain
 * http(s) origin or it is ignored.
 */
export function postLoginRedirect(returnToPath) {
  const path = safeReturnPath(returnToPath)
  const origin = (process.env.APP_ORIGIN ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/]+$/.test(origin)) return path
  return `${origin}${path}`
}
