import 'dotenv/config'
import { createApp, API_PREFIX } from './app.js'
import { prisma } from './lib/prisma.js'

const port = Number(process.env.PORT) || 4000

async function start() {
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch (err) {
    console.error('Cannot reach the database. Is `npm run db:up` running?')
    console.error(err.message)
    process.exit(1)
  }

  createApp().listen(port, () => {
    console.log(`AU Bounty API on http://localhost:${port}${API_PREFIX}`)
  })
}

start()
