# AU Bounty API image.
#
# Runs as the api service by default: waits for DATABASE_URL, applies
# `prisma migrate deploy`, serves /aubounty/api on :4000. The same image also
# serves as peer-mock via a compose command override:
#   command: ["node", "peer-mock/server.js"]
#   environment: DO_NOT_MIGRATE=1, PORT=7000
# (see docker-entrypoint.sh).

# ---- builder: full toolchain + generated prisma client -----------------------
FROM node:24-bookworm-slim AS builder
# Prisma links against openssl and talks https for engine downloads; slim has
# neither openssl nor a curl worth using.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# prisma.config.js reads the datasource url at load time; generate never
# connects, it just needs something that parses.
COPY prisma ./prisma
COPY prisma.config.js ./
RUN DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder?schema=public" \
  ./node_modules/.bin/prisma generate
COPY . .

# ---- prune: production node_modules, plus the prisma CLI itself --------------
# npm prune drops devDependencies, but migrate deploy on boot needs the CLI
# (a devDependency), so it is re-added pinned to the lockfile version. The
# client is regenerated afterwards so it can never be a stub after pruning.
FROM node:24-bookworm-slim AS prune
WORKDIR /app
COPY --from=builder /app ./
RUN PRISMA_CLI_VERSION="$(node -p "require('./package-lock.json').packages['node_modules/prisma'].version")" \
 && npm prune --omit=dev \
 && npm install --omit=dev --no-save "prisma@$PRISMA_CLI_VERSION" \
 && DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder?schema=public" \
    ./node_modules/.bin/prisma generate \
 && npm cache clean --force \
 && rm -rf /root/.npm

# ---- runtime: non-root app image ---------------------------------------------
FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000

# Source (src, prisma migrations, peer-mock) from the context; deps from prune.
COPY --chown=node:node . .
COPY --from=prune --chown=node:node /app/node_modules ./node_modules

COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/aubounty/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
