import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import 'dotenv/config'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const devUrl = new URL(
  process.env.DATABASE_URL ?? 'postgresql://aubounty:aubounty@localhost:5433/aubounty',
)
const testUrl = new URL(devUrl)
testUrl.pathname = '/aubounty_test'

/** `npm test` self-provisions: the aubounty_test database must simply exist. */
async function ensureDatabase() {
  const client = new pg.Client({ connectionString: devUrl.toString() })
  await client.connect()
  try {
    await client.query('CREATE DATABASE aubounty_test')
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
