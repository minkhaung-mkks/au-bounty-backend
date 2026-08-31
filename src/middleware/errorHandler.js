import { ApiError } from '../lib/errors.js'

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` },
  })
}

// Express 5 forwards rejected promises from async handlers here automatically.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err)

  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    })
  }

  // Prisma unique-constraint violation, e.g. applying to the same task twice.
  if (err?.code === 'P2002') {
    return res.status(409).json({
      error: { code: 'CONFLICT', message: 'That record already exists.', details: err.meta },
    })
  }
  if (err?.code === 'P2025') {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found.' } })
  }

  console.error(err)
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something broke on our side.' } })
}
