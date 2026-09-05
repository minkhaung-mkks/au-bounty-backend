import { ConfidentialClientApplication } from '@azure/msal-node'

/**
 * Microsoft Entra (Azure AD) configuration, read lazily so a missing block can
 * never crash the process at boot: /auth/login answers 503 and /meta reports
 * configured: false until the teammate lands the client secret.
 */
export function entraConfig() {
  return {
    tenantId: process.env.ENTRA_TENANT_ID ?? '',
    clientId: process.env.ENTRA_CLIENT_ID ?? '',
    clientSecret: process.env.ENTRA_CLIENT_SECRET ?? '',
    callbackBase:
      process.env.AUTH_CALLBACK_BASE ??
      `http://localhost:${process.env.PORT ?? 4000}/aubounty/api`,
  }
}

export function isEntraConfigured() {
  const { tenantId, clientId, clientSecret } = entraConfig()
  return Boolean(tenantId && clientId && clientSecret)
}

export function redirectUri() {
  return `${entraConfig().callbackBase}/auth/callback`
}

export const ENTRA_SCOPES = ['openid', 'email', 'profile']

// One confidential client per distinct config, so tests (and a secret landing
// mid-process) get a fresh instance instead of a client built from stale env.
let cached = null
let cachedKey = null

export function msalClient() {
  const { tenantId, clientId, clientSecret } = entraConfig()
  const key = `${tenantId}:${clientId}:${clientSecret}`
  if (!cached || cachedKey !== key) {
    cached = new ConfidentialClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        clientSecret,
      },
    })
    cachedKey = key
  }
  return cached
}
