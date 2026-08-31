export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const badRequest = (msg, details) => new ApiError(400, 'BAD_REQUEST', msg, details)
export const unauthorized = (msg = 'No user selected. Pick a user on the sign-in screen.') =>
  new ApiError(401, 'UNAUTHORIZED', msg)
export const forbidden = (msg) => new ApiError(403, 'FORBIDDEN', msg)
export const notFound = (msg = 'Not found') => new ApiError(404, 'NOT_FOUND', msg)
export const conflict = (msg) => new ApiError(409, 'CONFLICT', msg)
