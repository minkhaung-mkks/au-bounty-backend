import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

/**
 * A disposable stand-in for the SL Systems partner service (D6). It receives
 * the emergency alerts AU Bounty forwards and lists them back for the demo.
 * Plain node http, zero dependencies, so it runs anywhere node runs; when the
 * real partner is ready this directory is deleted, not ported.
 *
 * Endpoints:
 *   POST /api/peer/emergency-alerts   x-api-key auth; stores one alert
 *   GET  /api/peer/emergency-alerts   x-api-key auth; newest first
 *   GET  /health                      no auth
 */

const MAX_BODY_BYTES = 1_000_000

const readJson = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
      } else {
        chunks.push(chunk)
      }
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('body is not valid json'))
      }
    })
    req.on('error', reject)
  })

const send = (res, status, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * The server factory: tests import this and listen on an ephemeral port
 * in-process; `npm start` runs it on PORT with MOCK_API_KEY. The received
 * alerts live on `server.alerts` (newest first) so embedders can inspect or
 * reset the store directly; GET is the HTTP view of the same list.
 */
export function createPeerMock({ apiKey = process.env.MOCK_API_KEY ?? '' } = {}) {
  // Newest first, so the demo view needs no sorting.
  const alerts = []

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')

      if (url.pathname === '/health') return send(res, 200, { ok: true })

      if (url.pathname === '/api/peer/emergency-alerts') {
        // No key configured means nothing gets through: loud, not permissive.
        const given = req.headers['x-api-key'] ?? ''
        if (!apiKey || given !== apiKey) {
          return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Invalid API key.' } })
        }

        if (req.method === 'POST') {
          const body = await readJson(req)
          const alert = { id: randomUUID(), receivedAt: new Date().toISOString(), ...body }
          alerts.unshift(alert)
          return send(res, 200, { received: true, id: alert.id })
        }
        if (req.method === 'GET') return send(res, 200, { alerts })
        return send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } })
      }

      send(res, 404, { error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${url.pathname}` } })
    } catch (err) {
      send(res, 400, { error: { code: 'BAD_REQUEST', message: err.message } })
    }
  })
  server.alerts = alerts
  return server
}

/** Convenience for tests and demos: a listening mock plus its base url. */
export function startPeerMock({ apiKey, port = 0, host = '127.0.0.1' } = {}) {
  const server = createPeerMock({ apiKey })
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        server,
        url: `http://${host}:${server.address().port}`,
        alerts: server.alerts,
        // close() must not hang on a caller's idle keep-alive sockets.
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.()
            server.close(done)
          }),
      })
    })
  })
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const port = Number(process.env.PORT) || 7000
  if (!process.env.MOCK_API_KEY) {
    console.warn('MOCK_API_KEY is not set: every authenticated request will get 401.')
  }
  createPeerMock().listen(port, () => {
    console.log(`peer-mock on http://localhost:${port} (health: /health)`)
  })
}
