# AU Bounty Backend

![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-4-010101?logo=socket.io&logoColor=white)
![Vitest](https://img.shields.io/badge/tested_with-Vitest-6E9F18?logo=vitest&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)

The API behind [AU Bounty](https://github.com/sasta-kro/au-bounty), a campus task and event platform for Assumption University. Students post errands, organizations host events with rotating-code check-in, participants chat in real time, and double-blind reviews keep both sides honest.

This repository is a git submodule of the umbrella repo. The umbrella composes the full stack, publishes images, and holds the documentation. Most day-to-day work starts there:

- Umbrella: https://github.com/sasta-kro/au-bounty
- Frontend: https://github.com/minkhaung-mkks/au-bounty-frontend
- Live deployment: https://sai-aike-shwe-tun-aung-backend2.indonesiacentral.cloudapp.azure.com/aubounty/

## What the API does

- **Auth**: Microsoft Entra (ABAC single sign-on) through an OAuth code flow, issued as a one hour httpOnly session cookie. A separate throttled email and password login for seeded admin accounts. A dev-only header path for local work.
- **Tasks and events**: requests, emergencies, and org or teacher events. AUTO and APPROVAL seating with row-locked occupancy. A 60 second TOTP check-in code per event. Calendar export. Translation when keyed.
- **Realtime**: Socket.io channels for task updates, new emergencies, chat delivery, and read receipts.
- **Messaging**: one private thread per assignment, participant checked, cursor paginated.
- **Trust**: sealed double-blind reviews that publish on a fixed window, public profiles that work signed out, moderation that hides wording but never un-counts a rating.
- **Files**: presigned upload and download URLs against any S3-compatible store. MIME and size checks before signing.
- **Operations**: a settle engine that runs on every request (7 day auto-confirm, task locking, review publication), an email outbox that sends each reminder exactly once, admin routes for roles, orgs, tags, and moderation.

## Stack

Node 24, Express 5, Prisma 7 over PostgreSQL 17 through the pg driver adapter, Socket.io, zod for validation, jose and msal-node for auth, Vitest plus supertest for tests. Plain JavaScript, ESM. No TypeScript.

## Run it

The full stack with one command lives in the umbrella repo. For backend-only development:

```bash
docker compose up -d        # postgres on 5433, MinIO on 9100, bucket created
cp .env.example .env        # defaults target exactly those ports
npm install
npx prisma generate
npm run dev                 # API on http://localhost:4000/aubounty/api
```

Tests need the same postgres:

```bash
npm test                    # Vitest builds a separate aubounty_test database
```

Useful scripts: `db:migrate`, `db:reset`, `db:seed`, `db:seed:admins`, `db:studio`. All variables are documented in `.env.example` and in the [configuration reference](https://github.com/sasta-kro/au-bounty/blob/main/docs/configuration.md).

## Layout

```
src/
├── routes/       tasks, assignments, messages, reviews, files, admin, auth, users, tags, weather
├── realtime/     socket.io gateway, room authorization, event fan-out
├── services/     settle engine, email scheduler
├── middleware/   auth (cookie + dev), RBAC guards, validation, errors
├── lib/          prisma, filestore, mailer, maps, translate, weather, totp, ics
└── auth/         entra client, session signing, return-to handling
prisma/           schema, migrations, seeds
tests/            vitest suites, per-file databases
```

## Documentation

- [Architecture](https://github.com/sasta-kro/au-bounty/blob/main/docs/architecture.md): topology, auth paths, data model, degradation behavior
- [API reference](https://github.com/sasta-kro/au-bounty/blob/main/docs/api.md): every endpoint and the error envelope
- [Configuration](https://github.com/sasta-kro/au-bounty/blob/main/docs/configuration.md): every environment variable, the secrets provider, the vault
- [Deployment](https://github.com/sasta-kro/au-bounty/blob/main/docs/deployment.md): images, tags, the VM runbook
- [Getting started](https://github.com/sasta-kro/au-bounty/blob/main/docs/getting-started.md): clone, run, test

## Team

Term project for **CSX4110 Backend Application Development (Section 542)** at Assumption University.

| Developer | Student ID | Email |
|---|---|---|
| Sai Aike Shwe Tun Aung | 6712122 | u6712122@au.edu |
| Min Khaung Kyaw Swar | 6712164 | u6712164@au.edu |
| Ekaterina Kazakova | 6720065 | u6720065@au.edu |
