#!/bin/sh
# AU Bounty container entrypoint.
#
# Default (api service): waits for the database in DATABASE_URL, applies
# `prisma migrate deploy`, then execs CMD (`node src/index.js`) on :4000.
#
# peer-mock reuse: the same image doubles as the partner mock. Override the
# command and skip the db entirely:
#   command: ["node", "peer-mock/server.js"]
#   environment: DO_NOT_MIGRATE=1, PORT=7000 (its /health needs no auth)
set -e

if [ "${DO_NOT_MIGRATE:-0}" = "1" ]; then
  echo "DO_NOT_MIGRATE=1: skipping database wait and migrations"
  exec "$@"
fi

if [ -z "$DATABASE_URL" ]; then
  echo "docker-entrypoint: DATABASE_URL is required (or set DO_NOT_MIGRATE=1)" >&2
  exit 1
fi

# Wait for the database: plain TCP connect via node. The pg driver adapter
# needs no client binary and slim ships no nc/curl, so node it is.
# 30 attempts * 2s ~ 1 minute before giving up.
node -e '
const net = require("node:net")
const url = new URL(process.env.DATABASE_URL)
const host = url.hostname || "localhost"
const port = Number(url.port) || 5432
let tries = 0
const attempt = () => {
  const socket = net.connect({ host, port }, () => {
    socket.destroy()
    process.exit(0)
  })
  socket.on("error", () => {
    tries += 1
    if (tries >= 30) {
      console.error(`database at ${host}:${port} unreachable after ${tries} attempts`)
      process.exit(1)
    }
    setTimeout(attempt, 2000)
  })
}
attempt()
'

echo "docker-entrypoint: applying prisma migrations"
./node_modules/.bin/prisma migrate deploy

exec "$@"
