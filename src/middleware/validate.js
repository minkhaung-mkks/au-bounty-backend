import { badRequest } from '../lib/errors.js'

// Parsed values land on req.valid because Express 5 makes req.query read-only.
export const validate = (schemas) => (req, res, next) => {
  req.valid = {}
  for (const key of ['body', 'query', 'params']) {
    if (!schemas[key]) continue
    const result = schemas[key].safeParse(req[key])
    if (!result.success) {
      return next(
        badRequest(
          `Invalid request ${key}.`,
          result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      )
    }
    req.valid[key] = result.data
  }
  next()
}
