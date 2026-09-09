import { describe, test, expect } from 'vitest'
import { identityFromEmail } from '../src/auth/auIdentity.js'

// The AU tenant publishes no employeeId claim, so the sign-in address is the
// only role/student-id signal the callback has to work with.
describe('identityFromEmail', () => {
  test('a student address yields the id and STUDENT', () => {
    expect(identityFromEmail('u6712164@au.edu')).toEqual({
      universityId: '6712164',
      role: 'STUDENT',
    })
  })

  test('case and stray whitespace do not change the verdict', () => {
    expect(identityFromEmail('  U6712164@AU.EDU ')).toEqual({
      universityId: '6712164',
      role: 'STUDENT',
    })
  })

  test('any other au.edu address is staff and carries no student id', () => {
    expect(identityFromEmail('somchai.p@au.edu')).toEqual({
      universityId: null,
      role: 'TEACHER',
    })
  })

  test('a u-prefixed name that is not seven digits stays staff', () => {
    expect(identityFromEmail('umaporn@au.edu')).toEqual({
      universityId: null,
      role: 'TEACHER',
    })
    expect(identityFromEmail('u671@au.edu')).toEqual({
      universityId: null,
      role: 'TEACHER',
    })
  })

  test('a lookalike outside the tenant claims nothing', () => {
    // The pattern must be anchored to au.edu: an attacker-controlled domain
    // cannot mint a student id, and it must not be read as staff either.
    expect(identityFromEmail('u6712164@evil.example')).toEqual({
      universityId: null,
      role: 'STUDENT',
    })
    expect(identityFromEmail('u6712164@au.edu.evil.example')).toEqual({
      universityId: null,
      role: 'STUDENT',
    })
  })

  test('the synthetic no-claim fallback and junk keep schema defaults', () => {
    const fallback = identityFromEmail('some-oid@unset.au-bounty.invalid')
    expect(fallback).toEqual({ universityId: null, role: 'STUDENT' })
    expect(identityFromEmail(null)).toEqual({ universityId: null, role: 'STUDENT' })
    expect(identityFromEmail(undefined)).toEqual({ universityId: null, role: 'STUDENT' })
  })
})
