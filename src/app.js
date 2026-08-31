import 'dotenv/config'
import express from 'express'
import cors from 'cors'

import { devAuth } from './middleware/devAuth.js'
import { settleMiddleware } from './services/settle.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'

import { devRouter } from './routes/dev.js'
import { tagsRouter } from './routes/tags.js'
import { tasksRouter } from './routes/tasks.js'
import { assignmentsRouter } from './routes/assignments.js'
import { reviewsRouter } from './routes/reviews.js'
import { usersRouter } from './routes/users.js'

// Nginx will serve the built frontend at /aubounty and proxy this prefix through,
// and the peer contract with SL Systems publishes /aubounty/api/peer/... , so the
// prefix is baked in rather than added at deploy time.
export const API_PREFIX = '/aubounty/api'

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

  // Resolve who is asking, then bring any overdue state transitions up to date.
  api.use(devAuth)
  api.use(settleMiddleware)

  api.use(devRouter)
  api.use(tagsRouter)
  api.use(tasksRouter)
  api.use(assignmentsRouter)
  api.use(reviewsRouter)
  api.use(usersRouter)

  app.use(API_PREFIX, api)
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
