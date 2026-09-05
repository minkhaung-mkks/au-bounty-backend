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

// Nginx will serve the built frontend at /aubounty and proxy this prefix through,
// and the peer contract with SL Systems publishes /aubounty/api/peer/... , so the
// prefix is baked in rather than added at deploy time.
export const API_PREFIX = '/aubounty/api'

export const isDevAuthEnabled = () => process.env.DEV_AUTH === '1'

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

  // Capability flag for the frontend: which sign-in paths exist right now.
  api.get('/meta', (req, res) =>
    res.json({
      devAuth: isDevAuthEnabled(),
      auth: { provider: 'microsoft', configured: isEntraConfigured() },
    }),
  )

  // Login/callback/logout answer for themselves, before user resolution.
  api.use(authRouter)

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
  api.use(filesRouter)
  api.use(adminRouter)

  app.use(API_PREFIX, api)
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
