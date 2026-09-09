import 'dotenv/config'
import express from 'express'
import cors from 'cors'

import { cookieAuth } from './middleware/auth.js'
import { devAuth } from './middleware/devAuth.js'
import { isEntraConfigured } from './auth/entra.js'
import { settleMiddleware } from './services/settle.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'

import { authRouter } from './routes/auth.js'
import { devRouter } from './routes/dev.js'
import { tagsRouter } from './routes/tags.js'
import { tasksRouter } from './routes/tasks.js'
import { assignmentsRouter } from './routes/assignments.js'
import { messagesRouter } from './routes/messages.js'
import { reviewsRouter } from './routes/reviews.js'
import { usersRouter } from './routes/users.js'
import { filesRouter } from './routes/files.js'
import { adminRouter } from './routes/admin.js'
import { alertsRouter } from './routes/alerts.js'
import { peerRouter } from './routes/peer.js'
import { weatherRouter } from './routes/weather.js'

// Nginx will serve the built frontend at /aubounty and proxy this prefix through,
// and the peer contract with SL Systems publishes /aubounty/api/peer/... , so the
// prefix is baked in rather than added at deploy time.
export const API_PREFIX = '/aubounty/api'

export const isDevAuthEnabled = () => process.env.DEV_AUTH == '1'

export function createApp() {
  const app = express()

  app.use(
    cors({
      origin: process.env.CORS_ORIGIN?.split(',') ?? true,
      allowedHeaders: ['Content-Type', 'x-dev-user-id'],
    }),
  )
  app.use(express.json({ limit: '1mb' }))

  const api = express.Router()
  api.get('/health', (req, res) => res.json({ ok: true, version: '0.5.0' }))

  // Capability flag for the frontend: which sign-in paths and integrations
  // exist right now, so the UI degrades gracefully when a key is missing.
  api.get('/meta', (req, res) =>
    res.json({
      devAuth: isDevAuthEnabled(),
      auth: { provider: 'microsoft', configured: isEntraConfigured() },
      capabilities: {
        maps: Boolean(process.env.GOOGLE_MAPS_KEY),
        translation: Boolean(process.env.GOOGLE_TRANSLATE_KEY),
        weather: true, // Open-Meteo is keyless
        files: true,
      },
    }),
  )

  // Login/callback/logout answer for themselves, before user resolution.
  api.use(authRouter)

  // The partner's inbound endpoint is its own security domain (x-api-key, not
  // a user session), so it mounts ahead of the user-resolution middleware.
  api.use(peerRouter)

  // Resolve who is asking: the session cookie always, the dev header only in
  // dev. Then bring any overdue state transitions up to date.
  api.use(cookieAuth)
  if (isDevAuthEnabled()) api.use(devAuth)
  api.use(settleMiddleware)

  if (isDevAuthEnabled()) api.use(devRouter)
  api.use(tagsRouter)
  api.use(tasksRouter)
  api.use(assignmentsRouter)
  api.use(messagesRouter)
  api.use(reviewsRouter)
  api.use(usersRouter)
  api.use(weatherRouter)
  api.use(alertsRouter)
  api.use(filesRouter)
  api.use(adminRouter)

  app.use(API_PREFIX, api)
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
