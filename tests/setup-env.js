import 'dotenv/config'

// Runs in every worker before test modules load, so src/lib/prisma.js (which
// reads DATABASE_URL at import time) lands on the test database.
const url = new URL(
  process.env.DATABASE_URL ?? 'postgresql://aubounty:aubounty@localhost:5433/aubounty',
)
url.pathname = '/aubounty_test'
process.env.DATABASE_URL = url.toString()

// Deterministic auth env; individual tests override what they care about.
process.env.JWT_SECRET ??= 'test-jwt-secret-never-for-production'
process.env.COOKIE_SECURE = 'false'
process.env.APP_ORIGIN = ''
process.env.ENTRA_TENANT_ID = '11111111-1111-1111-1111-111111111111'
process.env.ENTRA_CLIENT_ID = '22222222-2222-2222-2222-222222222222'
process.env.ENTRA_CLIENT_SECRET = ''
