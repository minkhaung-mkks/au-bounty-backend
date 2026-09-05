import { describe, test, expect } from 'vitest'
import {
  STEP_SECONDS,
  codeAt,
  currentCode,
  keyBytes,
  remainingSeconds,
  stepIndex,
  verify,
} from '../src/lib/totp.js'

// Frozen clock for every deterministic assertion below.
const AT = 1_700_000_000_000
const STEP = Math.floor(AT / 1000 / 60) // 28333333

// The seed's literal, non-hex event secret.
const SEED_SECRET = 'SEEDSECRETA'
// What task creation stores: randomBytes(...).toString('hex').
const HEX_SECRET = 'a1b2c3d4e5f60718'

describe('totp key interpretation', () => {
  test('hex-looking secrets are hex-decoded to their original bytes', () => {
    expect(keyBytes(HEX_SECRET).toString('hex')).toBe(HEX_SECRET)
    expect(keyBytes(SEED_SECRET).toString('utf8')).toBe(SEED_SECRET)
  })

  test('odd-length or non-hex secrets fall back to utf8 bytes', () => {
    expect(keyBytes('abc')).toHaveLength(3) // odd length: not valid hex
    expect(keyBytes('xyz not hex').toString('utf8')).toBe('xyz not hex')
  })

  test('the two interpretations of the same string disagree', () => {
    // 'aaaa' is valid hex (0xaaaa) while '41414141' decodes to utf8 'AAAA',
    // so neither key equals the other's bytes and the codes differ.
    expect(keyBytes('aaaa').toString('hex')).toBe('aaaa')
    expect(keyBytes('41414141').toString('utf8')).toBe('AAAA')
  })
})

describe('totp codes', () => {
  test('exact codes at a frozen time (golden values)', () => {
    expect(currentCode(SEED_SECRET, AT)).toBe('147935')
    expect(currentCode(HEX_SECRET, AT)).toBe('556342')
  })

  test('hex decoding is what produced the hex-secret golden, not utf8', () => {
    // Wrongly reading the hex secret as utf8 bytes yields 163258, not 556342.
    expect(currentCode(HEX_SECRET, AT)).not.toBe('163258')
    expect(codeAt(SEED_SECRET, STEP - 1)).toBe('066432')
    expect(codeAt(SEED_SECRET, STEP + 1)).toBe('803407')
  })

  test('codes are six digits and differ per step', () => {
    const code = currentCode(SEED_SECRET, AT)
    expect(code).toMatch(/^\d{6}$/)
    expect(codeAt(SEED_SECRET, STEP)).not.toBe(codeAt(SEED_SECRET, STEP + 1))
  })
})

describe('totp verify', () => {
  test('accepts the current code', () => {
    expect(verify(SEED_SECRET, currentCode(SEED_SECRET, AT), AT)).toBe(true)
  })

  test('accepts +/- one step of clock drift', () => {
    expect(verify(SEED_SECRET, codeAt(SEED_SECRET, STEP - 1), AT)).toBe(true)
    expect(verify(SEED_SECRET, codeAt(SEED_SECRET, STEP + 1), AT)).toBe(true)
  })

  test('rejects two steps stale and any further future step', () => {
    expect(verify(SEED_SECRET, codeAt(SEED_SECRET, STEP - 2), AT)).toBe(false)
    expect(verify(SEED_SECRET, codeAt(SEED_SECRET, STEP + 2), AT)).toBe(false)
  })

  test('rejects garbage without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '000000', null, 123456]) {
      expect(verify(SEED_SECRET, bad, AT)).toBe(false)
    }
  })

  test('a code from a different secret never validates', () => {
    expect(verify(SEED_SECRET, currentCode(HEX_SECRET, AT), AT)).toBe(false)
  })
})

describe('totp step timing', () => {
  test('remainingSeconds counts down inside a step', () => {
    expect(remainingSeconds(AT)).toBe(40)
    expect(STEP_SECONDS).toBe(60)
    expect(stepIndex(AT)).toBe(STEP)
  })

  test('a step boundary reports a full period left', () => {
    const boundary = STEP * STEP_SECONDS * 1000
    expect(remainingSeconds(boundary)).toBe(60)
    expect(stepIndex(boundary - 1)).toBe(STEP - 1)
  })
})
