import 'dotenv/config'
import { createApp, API_PREFIX } from './app.js'
import { prisma } from './lib/prisma.js'
import { attachSockets } from './realtime/gateway.js'
import { startAlertSweeper, stopAlertSweeper } from './services/alertSweeper.js'
import { startMailScheduler, stopMailScheduler } from './services/mailScheduler.js'

const port = Number(process.env.PORT) || 4000

async function start() {
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch (err) {
    console.error('Cannot reach the database. Is `npm run db:up` running?')
    console.error(err.message)
    process.exit(1)
  }

  const server = createApp().listen(port, () => {
    console.log(`AU Bounty API on http://localhost:${port}${API_PREFIX}`)
  })
  // Realtime rides the same HTTP server under its own path (D2).
  attachSockets(server)
  // Outbound alert forwarding retries (D6): an immediate pass, then every 30s.
  startAlertSweeper()
  // Email triggers + retries (D8): an immediate pass, then every 60s.
  startMailScheduler()

  // Orderly shutdown: stop the background loops before anything else so no
  // pass fires mid-close, then let the server drain and release the db pool.
  let closing = false
  const shutdown = () => {
    if (closing) return
    closing = true
    stopAlertSweeper()
    stopMailScheduler()
    server.close(async () => {
      await prisma.$disconnect()
      process.exit(0)
    })
    // Anything still holding a handle after 5s cannot be waited out.
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

start()
