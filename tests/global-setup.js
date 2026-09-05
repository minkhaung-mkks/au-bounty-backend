import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import 'dotenv/config'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const devUrl = new URL(
  process.env.DATABASE_URL ?? 'postgresql://aubounty:aubounty@localhost:5433/aubounty',
)
// TEST_DATABASE_URL pins the whole database (parallel workers in one checkout
// each get their own); without it the default shared test database applies.
const testUrl = process.env.TEST_DATABASE_URL
  ? new URL(process.env.TEST_DATABASE_URL)
  : new URL(devUrl)
if (!process.env.TEST_DATABASE_URL) testUrl.pathname = '/aubounty_test'
const testDbName = testUrl.pathname.slice(1)

/** `npm test` self-provisions: the test database must simply exist. */
async function ensureDatabase() {
  const adminUrl = new URL(testUrl)
  adminUrl.pathname = devUrl.pathname || '/postgres'
  const client = new pg.Client({ connectionString: adminUrl.toString() })
  await client.connect()
  try {
    await client.query(`CREATE DATABASE "${testDbName}"`)
  } catch (err) {
    if (err.code !== '42P04') throw err // 42P04 = duplicate_database, expected
  } finally {
    await client.end()
  }
}

export async function setup() {
  await ensureDatabase()
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
    stdio: 'inherit',
  })
}
