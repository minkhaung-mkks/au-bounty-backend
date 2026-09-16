import { DefaultAzureCredential } from '@azure/identity'
import { SecretClient } from '@azure/keyvault-secrets'

/**
 * Secrets bootstrap, the SECRETS_PROVIDER switch promised in the env contract.
 *
 * `env` (default): everything comes from the environment and this module is a
 * no-op, so local dev and CI never touch Azure.
 *
 * `keyvault`: before the app listens, fetch the mapped secrets from Azure Key
 * Vault (URL in KEY_VAULT_URL) and write them into process.env, so the lazy
 * env readers (entra.js, middleware/auth.js, integrations) pick them up with
 * zero changes. Authentication follows DefaultAzureCredential: the
 * AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET service principal in
 * env first, managed identity automatically when those are absent.
 *
 * Boot fails closed: an unreachable vault or a missing secret exits the
 * process instead of serving with half its credentials.
 */

// Key Vault secret names allow only [0-9a-zA-Z-], so dashes stand in for the
// underscores of the env names they map to.
export const SECRET_MAP = {
  'entra-client-secret': 'ENTRA_CLIENT_SECRET',
  'jwt-secret': 'JWT_SECRET',
  'resend-api-key': 'RESEND_API_KEY',
  'google-maps-key': 'GOOGLE_MAPS_KEY',
  'google-translate-key': 'GOOGLE_TRANSLATE_KEY',
}

/**
 * Fetches secrets into process.env. No-op unless SECRETS_PROVIDER=keyvault.
 * `only` narrows the fetch to specific vault names, because a service should
 * only pull the credentials it uses.
 */
export async function loadSecrets(only) {
  const provider = (process.env.SECRETS_PROVIDER ?? 'env').trim().toLowerCase()
  if (provider !== 'keyvault') return []

  const vaultUrl = process.env.KEY_VAULT_URL
  if (!vaultUrl) {
    console.error('secrets: SECRETS_PROVIDER=keyvault but KEY_VAULT_URL is not set')
    process.exit(1)
  }

  const wanted = Object.keys(SECRET_MAP).filter((name) => !only || only.includes(name))
  const client = new SecretClient(vaultUrl, new DefaultAzureCredential())

  const loaded = []
  for (const name of wanted) {
    try {
      const { value } = await client.getSecret(name)
      if (!value) throw new Error('secret exists but its value is empty')
      process.env[SECRET_MAP[name]] = value
      loaded.push(name)
    } catch (err) {
      console.error(`secrets: could not load '${name}' from the vault:`, err.message)
      process.exit(1)
    }
  }
  console.log(`secrets: loaded from key vault: ${loaded.join(', ')}`)
  return loaded
}
