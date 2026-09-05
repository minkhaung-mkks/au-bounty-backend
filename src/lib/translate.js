/**
 * D10 translation. Google Cloud Translation v2 when GOOGLE_TRANSLATE_KEY is
 * set, identity otherwise (or on any API failure): the caller always gets the
 * strings back plus a `translated` flag, so the frontend can offer the control
 * whenever /meta reports the capability and still degrade cleanly.
 */

const TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2'
const TRANSLATE_TIMEOUT_MS = 10_000

/**
 * Translate a batch of strings into `targetLang` (two-letter code).
 * Returns { values, translated }: either Google's translations with
 * translated true, or the originals untouched with translated false.
 */
export async function translateTexts(strings, targetLang) {
  const key = process.env.GOOGLE_TRANSLATE_KEY
  if (!key) return { values: strings, translated: false }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS)
  try {
    const response = await fetch(`${TRANSLATE_URL}?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: strings, target: targetLang.toLowerCase(), format: 'text' }),
      signal: controller.signal,
    })
    if (!response.ok) return { values: strings, translated: false }
    const data = await response.json()
    const translations = data?.data?.translations
    if (!Array.isArray(translations) || translations.length !== strings.length) {
      return { values: strings, translated: false }
    }
    return { values: translations.map((t) => String(t.translatedText)), translated: true }
  } catch {
    return { values: strings, translated: false } // timeout / network / bad body
  } finally {
    clearTimeout(timeout)
  }
}
