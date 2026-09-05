# peer-mock

A disposable stand-in for the SL Systems partner campus system. AU Bounty's
backend forwards emergency alerts here (`PEER_OUTBOUND_URL`); this service
stores them in memory and lists them back for demos. Zero dependencies, plain
node http. When the real partner cutover happens, this directory is deleted.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `7000` | Listen port. |
| `MOCK_API_KEY` | unset | The `x-api-key` callers must present. Unset means every authenticated request gets 401. |

## Run

```sh
MOCK_API_KEY=dev-peer-outbound-key npm start
```

## Endpoints

- `POST /api/peer/emergency-alerts` — `x-api-key` required. Body is the alert
  AU Bounty sends (`universityId, name, email, lat, lng, message, pressedAt`).
  Stores it in memory, answers `200 { "received": true, "id": ... }`.
- `GET /api/peer/emergency-alerts` — `x-api-key` required. All received alerts,
  newest first: `{ "alerts": [...] }`.
- `GET /health` — no auth. `{ "ok": true }`.

## Tests

`server.js` exports `createPeerMock({ apiKey })` (a node `http.Server`) and
`startPeerMock({ apiKey, port })` (resolves to `{ server, url, close }`), so
the backend's vitest suite runs it in-process on an ephemeral port.
