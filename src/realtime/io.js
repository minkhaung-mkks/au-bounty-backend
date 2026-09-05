/**
 * The process-wide socket.io server handle, set once by attachSockets() when
 * the HTTP server starts. Routes import the emitters from realtime/emit.js,
 * which no-op until a gateway is attached, so the same route code works in
 * tests that only exercise REST through supertest.
 */
let io = null

export const setIo = (server) => {
  io = server
}

export const resetIo = () => {
  io = null
}

export const getIo = () => io
