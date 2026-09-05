import { describe, test, expect, beforeEach, vi } from 'vitest'

// msal is mocked at the module boundary: ConfidentialClientApplication never
// touches the network in tests, and the class mock also records the config it
// was built with so the tenant/client wiring is assertable.
const msal = vi.hoisted(() => ({
  getAuthCodeUrl: vi.fn(),
  acquireTokenByCode: vi.fn(),
}))

vi.mock('@azure/msal-node', () => ({
  // A plain function (not an arrow) so `new ConfidentialClientApplication()`
  // works; the config it was built with stays assertable via mock.calls.
  ConfidentialClientApplication: vi.fn(function ConfidentialClientApplication(config) {
    this.getAuthCodeUrl = msal.getAuthCodeUrl
    this.acquireTokenByCode = msal.acquireTokenByCode
    this.__config = config
  }),
}))

import request from 'supertest'
import { ConfidentialClientApplication } from '@azure/msal-node'
import { prisma } from '../src/lib/prisma.js'
import { safeReturnPath } from '../src/auth/returnTo.js'
import { CALLBACK_BASE, TEST_CLIENT_ID, TEST_TENANT_ID, appWith, createUser, resetDb } from './helpers.js'

const AUTH_URL = `https://login.microsoftonline.com/${TEST_TENANT_ID}/oauth2/v2.0/authorize?client_id=${TEST_CLIENT_ID}`

beforeEach(async () => {
  await resetDb()
  vi.clearAllMocks()
})

describe('GET /auth/login', () => {
  test('302s to Microsoft with tenant, client id, callback and state', async () => {
    msal.getAuthCodeUrl.mockResolvedValue(AUTH_URL)
    const app = appWith({ entraSecret: 'secret-value' })

    const res = await request(app).get('/aubounty/api/auth/login?returnTo=/tasks')

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(AUTH_URL)
    expect(res.headers.location).toContain(TEST_TENANT_ID)
    expect(res.headers.location).toContain(TEST_CLIENT_ID)
    expect(ConfidentialClientApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({
          clientId: TEST_CLIENT_ID,
          authority: `https://login.microsoftonline.com/${TEST_TENANT_ID}`,
          clientSecret: 'secret-value',
        }),
      }),
    )
    expect(msal.getAuthCodeUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ['openid', 'email', 'profile'],
        redirectUri: `${CALLBACK_BASE}/auth/callback`,
        state: expect.any(String),
      }),
    )
  })

  test('503 { error: "auth not configured" } when the entra block is incomplete', async () => {
    const app = appWith({ entraSecret: '' })
    const res = await request(app).get('/aubounty/api/auth/login')
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'auth not configured' })
    expect(msal.getAuthCodeUrl).not.toHaveBeenCalled()
  })
})

describe('GET /auth/callback', () => {
  test('a new msadOid creates a STUDENT user and sets the session cookie', async () => {
    const app = appWith({ entraSecret: 'secret-value' })
    msal.acquireTokenByCode.mockResolvedValue({
      uniqueId: 'oid-new',
      idTokenClaims: { oid: 'oid-new', name: 'Jane Doe', preferred_username: 'jane@au.edu' },
    })

    const res = await request(app).get('/aubounty/api/auth/callback?code=abc&state=')

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/')

    const user = await prisma.user.findUnique({ where: { msadOid: 'oid-new' } })
    expect(user).toMatchObject({
      name: 'Jane Doe',
      email: 'jane@au.edu',
      role: 'STUDENT',
      universityId: null,
    })

    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('aubounty_token='))
    expect(cookie).toBeDefined()
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Path=/aubounty')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=3600')
    expect(cookie).not.toContain('Secure')

    // The cookie we just issued authenticates the next request.
    const me = await request(app)
      .get('/aubounty/api/me')
      .set('Cookie', cookie.split(';')[0])
    expect(me.status).toBe(200)
    expect(me.body.user).toMatchObject({ name: 'Jane Doe', role: 'STUDENT' })
  })

  test('an existing msadOid reuses the row and updates changed name/email', async () => {
    const app = appWith({ entraSecret: 'secret-value' })
    await createUser({ msadOid: 'oid-known', name: 'Old Name', email: 'old@au.edu', universityId: '6700001' })
    msal.acquireTokenByCode.mockResolvedValue({
      idTokenClaims: { oid: 'oid-known', name: 'New Name', preferred_username: 'new@au.edu' },
    })

    const res = await request(app).get('/aubounty/api/auth/callback?code=abc&state=')

    expect(res.status).toBe(302)
    const count = await prisma.user.count({ where: { msadOid: 'oid-known' } })
    expect(count).toBe(1)
    const user = await prisma.user.findUnique({ where: { msadOid: 'oid-known' } })
    expect(user).toMatchObject({ name: 'New Name', email: 'new@au.edu', universityId: '6700001' })
  })

  test('a claim-sourced employeeId fills an empty universityId slot only', async () => {
    const app = appWith({ entraSecret: 'secret-value' })
    msal.acquireTokenByCode.mockResolvedValue({
      idTokenClaims: { oid: 'oid-emp', name: 'Emp', preferred_username: 'emp@au.edu', employeeId: '6701234' },
    })
    await request(app).get('/aubounty/api/auth/callback?code=abc&state=')
    expect(
      (await prisma.user.findUnique({ where: { msadOid: 'oid-emp' } })).universityId,
    ).toBe('6701234')

    // Second sign-in with a different claim must not move it.
    msal.acquireTokenByCode.mockResolvedValue({
      idTokenClaims: { oid: 'oid-emp', name: 'Emp', preferred_username: 'emp@au.edu', employeeId: '9999999' },
    })
    await request(app).get('/aubounty/api/auth/callback?code=abc&state=')
    expect(
      (await prisma.user.findUnique({ where: { msadOid: 'oid-emp' } })).universityId,
    ).toBe('6701234')
  })

  test('redirects to the sanitized returnTo carried in state', async () => {
    const app = appWith({ entraSecret: 'secret-value' })
    msal.getAuthCodeUrl.mockImplementation(
      async (req) => `${AUTH_URL}&state=${encodeURIComponent(req.state)}`,
    )
    msal.acquireTokenByCode.mockResolvedValue({
      idTokenClaims: { oid: 'oid-r', name: 'R', preferred_username: 'r@au.edu' },
    })

    await request(app).get('/aubounty/api/auth/login?returnTo=/tasks/42')
    const encoded = msal.getAuthCodeUrl.mock.calls[0][0].state

    const res = await request(app).get(`/aubounty/api/auth/callback?code=abc&state=${encodeURIComponent(encoded)}`)
    expect(res.headers.location).toBe('/tasks/42')
  })

  test('an evil returnTo never becomes the redirect target', async () => {
    const app = appWith({ entraSecret: 'secret-value' })
    msal.getAuthCodeUrl.mockResolvedValue(AUTH_URL)
    msal.acquireTokenByCode.mockResolvedValue({
      idTokenClaims: { oid: 'oid-e', name: 'E', preferred_username: 'e@au.edu' },
    })

    await request(app).get('/aubounty/api/auth/login?returnTo=https://evil.example.net/catch')
    const encoded = msal.getAuthCodeUrl.mock.calls[0][0].state

    const res = await request(app).get(`/aubounty/api/auth/callback?code=abc&state=${encodeURIComponent(encoded)}`)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/')
    expect(res.headers.location).not.toContain('evil.example.net')
  })

  test('APP_ORIGIN prefixes the redirect for cross-origin dev setups', async () => {
    const app = appWith({ entraSecret: 'secret-value', appOrigin: 'http://localhost:5173/' })
    msal.getAuthCodeUrl.mockResolvedValue(AUTH_URL)
    msal.acquireTokenByCode.mockResolvedValue({
      idTokenClaims: { oid: 'oid-o', name: 'O', preferred_username: 'o@au.edu' },
    })

    await request(app).get('/aubounty/api/auth/login?returnTo=/tasks')
    const encoded = msal.getAuthCodeUrl.mock.calls[0][0].state
    const res = await request(app).get(`/aubounty/api/auth/callback?code=abc&state=${encodeURIComponent(encoded)}`)
    expect(res.headers.location).toBe('http://localhost:5173/tasks')
  })

  test('a Microsoft-side error surfaces as 401 instead of a redirect loop', async () => {
    const app = appWith({ entraSecret: 'secret-value' })
    const res = await request(app).get(
      '/aubounty/api/auth/callback?error=access_denied&error_description=user+refused',
    )
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_FAILED')
  })

  test('503 when not configured', async () => {
    const app = appWith({ entraSecret: '' })
    const res = await request(app).get('/aubounty/api/auth/callback?code=abc')
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'auth not configured' })
  })
})

describe('GET /auth/logout', () => {
  test('clears the cookie and returns 204 with no body', async () => {
    const app = appWith()
    const res = await request(app).get('/aubounty/api/auth/logout')

    expect(res.status).toBe(204)
    expect(res.text).toBe('')
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('aubounty_token='))
    expect(cookie).toContain('Path=/aubounty')
    // "cleared" means an expiry in the past
    expect(new Date(cookie.match(/Expires=([^;]+)/i)?.[1]).getTime()).toBeLessThan(Date.now())
  })
})

describe('safeReturnPath', () => {
  test.each([
    ['/tasks/42', '/tasks/42'],
    ['/', '/'],
    ['', '/'],
    ['https://evil.example.net/x', '/'],
    ['//evil.example.net', '/'],
    ['/\\evil.example.net', '/'],
    ['javascript:alert(1)', '/'],
    ['/okay?next=https://evil.example.net', '/okay?next=https://evil.example.net'],
  ])('%j -> %j', (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected)
  })
})
