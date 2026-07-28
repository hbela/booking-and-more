This is the execution plan for the first delivery phase, derived from PRD.md §24 (Phase 0) and technical-implementation.md §44 (Epic 0).

# Phase 0 — Technical Foundation

## Implementation Plan

**Document version:** 1.0
**Scope:** Epic 0 only — repository, applications, and conventions
**Depends on:** [PRD.md](PRD.md), [technical-implementation.md](technical-implementation.md)
**Exit criteria:** All applications run locally · CI passes · API connects to PostgreSQL · Health checks green

---

# 1. Context

`booking-and-more` currently contains nothing but two specification documents. They describe a multi-tenant,
voice-enabled booking SaaS to be delivered across eight phases (Epic 0 → Epic 10).

This document covers **Phase 0 / Epic 0 only** — the repository, applications, and conventions that everything
else is built on. Nothing user-visible ships in this phase. That is deliberate: three predecessor projects
exist on this machine, and their failure modes were almost all _foundation_ failures — schema drift,
unvalidated routes, boot crashes on missing keys, absent CI. Locking the conventions now, before they get
copied across a large codebase, is the whole point of the phase.

---

# 2. Prior Art

| Repository                        | Verdict                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c:\devs\prods\booking-for-all`   | Fastify + Prisma + Better Auth + Stripe + Sentry plumbing is mature. **The domain model must be discarded** — it pre-materialises every bookable slot as an `Event` row. No availability engine, no holds, no calendar sync, no queue, no CI.                                                     |
| `c:\devs\prods\sunshine-dental`   | Production dental AI receptionist, one stack per clinic. Crown jewels for later phases: prompt-as-code with snapshot tests, an Anthropic tool-calling agent loop, a pure tested `generateSlots()`, AES-GCM field encryption, and a complete en/hu/de i18n set (14 namespaces, natively reviewed). |
| `c:\devs\prods\appointer-console` | Operator console. Cleanest **Better Auth + Fastify auth plugin** of the three, plus a working Stripe billing module with webhook idempotency, zod-validated settings, and never-throw audit writes.                                                                                               |

Nothing in any of the three has Google Calendar, Redis/BullMQ, OpenAI transcription, Next.js, row-level
multi-tenancy, or a single CI workflow file. Those are genuinely greenfield.

The single most valuable artifact across all three is
`c:\devs\prods\booking-for-all\docs\deployment-fixes-2026-07-27.md` — five stacked production failures traced
to root cause. Its lessons are encoded as conventions in §12 below.

---

# 3. Environment Constraints

Verified on this machine:

- Node **v24.14.0**, pnpm **10.32.1**, git **2.54** — present.
- **Docker is not installed.** No WSL distribution.
- **PostgreSQL 18 running natively on `0.0.0.0:5432`.** `btree_gist` and `citext` are available in
  `C:\Program Files\PostgreSQL\18\share\extension\`, so the exclusion-constraint concurrency design in
  technical-implementation.md §11.2–§11.3 works exactly as specified.
- **No Redis.**

---

# 4. Decisions

1. **Local development runs against native PostgreSQL 18. Redis is deferred to Epic 5** (BullMQ / outbox),
   which is the first thing that genuinely needs it. Better Auth uses database sessions; rate limiting starts
   in-memory. Dockerfiles and `docker-compose.yml` are still written this phase for Coolify/Hetzner parity —
   they are simply not run locally.
2. **`apps/web` is Next.js App Router**, per PRD.md §16. Public booking pages need server rendering for SEO,
   per-tenant white-label branding at request time, custom-domain routing, and the PWA and embeddable-widget
   story. This is chosen despite all three predecessors shipping Vite + TanStack Router.
3. **Phase 0 delivers Epic 0 only.**
4. **`git init` locally**, no remote yet.
5. **Package scope is `@bam/*`.**

## 4.1 Deviation from the technical plan

technical-implementation.md §39.3 specifies **Testcontainers** for repository integration tests.
Testcontainers requires Docker, which is not installed. Integration tests will instead run against a
`booking_and_more_test` database on the native PostgreSQL instance locally, and against a `postgres:18`
**service container** in GitHub Actions. Same SQL, same extensions, no Docker on the development machine.
If Docker Desktop is installed later, switching to Testcontainers is a contained change.

---

# 5. Repository Skeleton

```text
booking-and-more/
├── apps/
│   ├── api/                  Fastify 5
│   ├── web/                  Next.js 16 App Router
│   └── worker/               BullMQ worker (idles until REDIS_URL is set)
├── packages/
│   ├── db/                   Prisma schema, migrations, client singleton
│   ├── contracts/            Shared Zod schemas, error codes, API envelope types
│   ├── config/               Zod-validated environment loader
│   ├── observability/        Pino logger and Sentry initialisation helpers
│   ├── tsconfig/
│   └── eslint-config/
├── docker/                   Dockerfile.api | web | worker, docker-compose.yml
├── .github/workflows/ci.yml
├── docs/                     PRD, technical implementation plan, this document
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── package.json
├── .gitignore
├── .env.example
└── CLAUDE.md
```

Trimmed from technical-implementation.md §4 to what Epic 0 requires. The `auth`, `booking-engine`,
`availability-engine`, `ai`, `calendar`, and `notifications` packages are created in their own epics rather
than stubbed now.

**Reuse:** `tsconfig.base.json` is lifted from `booking-for-all\tsconfig.base.json` — `strict`,
`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, ESM throughout.
Those settings were good and are the one thing in that repository nobody regretted.

**Turborepo:** unlike `booking-for-all\turbo.json`, declare `env` and `globalDependencies` so the cache is
actually correct, and add a `test` task — it had none.

---

# 6. Environment Configuration — `packages/config`

A single Zod schema, parsed **once at the process edge**, failing fast with a readable error that lists every
missing key. No `process.env` access anywhere else in the codebase.

Phase 0 variables, a subset of technical-implementation.md §42:

```env
NODE_ENV
APP_BASE_URL
API_BASE_URL
PORT
DATABASE_URL
LOG_LEVEL
SENTRY_DSN          # optional
REDIS_URL           # optional in this phase
```

Model on `appointer-console\apps\api\src\config\env.ts`.

Deliberately **not** modelled on `booking-for-all\packages\db\src\index.ts`, which grew roughly eighty lines
of environment-file precedence heuristics and Prisma Accelerate URL sniffing. We use a plain `postgresql://`
URL and no Accelerate — that split caused several of their outages.

---

# 7. Database — `packages/db`

- Prisma 7, PostgreSQL. The generated client is **gitignored**; `booking-for-all` committed theirs, including
  a Windows `.dll.node` binary.
- Client singleton. No query-layer `$extends` workarounds.

  Two Prisma 7 changes are worth recording, because both are breaking relative to the Prisma 6 the technical
  plan assumes:

  1. `url` was removed from the `datasource` block. The CLI connection lives in `prisma.config.ts`; the
     runtime client connects through the `@prisma/adapter-pg` driver adapter.
  2. The `prisma-client` generator emits **TypeScript**, not JavaScript. The generated directory is therefore
     part of the package's compilation (and excluded from ESLint) rather than something that can simply be
     ignored.

  Also renamed: `prisma migrate diff --to-schema-datamodel` is now `--to-schema`.

- **Migration 1 (custom SQL):** `CREATE EXTENSION IF NOT EXISTS btree_gist;` and `citext`. Both verified
  available in the local PostgreSQL 18 installation. Required by Epic 4's `EXCLUDE USING gist` constraint.
- **Migration 2:** the `Tenant` model exactly as specified in technical-implementation.md §10.1 —
  id, name, slug (unique), status, default_language, default_timezone, logo_url, primary_color,
  contact_email, contact_phone, booking_policy, privacy_policy_url, cancellation_policy, timestamps — plus a
  `TenantStatus` enum of `ACTIVE | SUSPENDED | TRIAL | CLOSED`.

  One real model proves the migration path end to end and gives `/health/ready` something to query.
  Memberships, users, and RBAC land in Epic 1.

- A seed script creating a `sunshine-dental` demonstration tenant.

## 7.1 Migration discipline

**Migrations are the only path to schema change. `prisma db push` is never run against a shared database.**

This is the direct lesson of `booking-for-all\docs\deployment-fixes-2026-07-27.md` and
`packages\db\DRIFT_EXPLANATION.md`, where a `db push` plus a backfill script left a comment-only migration
file and a production drift incident.

CI enforces it with `prisma migrate diff --from-url --to-schema-datamodel --exit-code`. Note that
`prisma migrate status` does **not** catch this class of drift.

---

# 8. API — `apps/api`

A composition root `app.ts` exporting `buildApp()`, so `fastify.inject()` tests run without a listening
socket, plus a thin `server.ts` that loads configuration and listens.

## 8.1 Plugins

A subset of technical-implementation.md §7, each a genuine `fastify-plugin`:

| Plugin                      | Purpose                                                         |
| --------------------------- | --------------------------------------------------------------- |
| `config.plugin.ts`          | Decorates validated environment configuration                   |
| `database.plugin.ts`        | Prisma client lifecycle                                         |
| `request-context.plugin.ts` | `requestId`, AsyncLocalStorage, log binding (§7.1)              |
| `error-handler.plugin.ts`   | ZodError → 422, `AppError` → statusCode, otherwise Sentry + 500 |
| `openapi.plugin.ts`         | `@fastify/swagger` and swagger-ui at `/docs`                    |
| `rate-limit.plugin.ts`      | In-memory store this phase; swaps to Redis in Epic 5            |

## 8.2 Modules

`health/` only.

```http
GET /health/live      Process is running
GET /health/ready     PostgreSQL reachable, required configuration present, Redis only if configured
```

## 8.3 Two conventions that must hold from the first route

**Schema-first routes.** Every route declares `schema: { body, querystring, params, response }` through
`fastify-type-provider-zod`. `booking-for-all` registered the type provider and then wrote
`(req.body as any)` throughout, which silently killed runtime validation, response serialization, and the
OpenAPI specification alike — leaving a committed 240 KB `openapi.json` that described nothing. Add an ESLint
rule or CI check rejecting `as any` on `req.body`, `req.query`, and `req.params`.

**A standard error envelope**, per technical-implementation.md §15.1:

```json
{
  "error": {
    "code": "SLOT_NO_LONGER_AVAILABLE",
    "message": "This appointment is no longer available.",
    "requestId": "req_123",
    "details": {}
  }
}
```

Port the duck-typed `isAppError` flag from `booking-for-all\apps\server\src\errors\AppError.ts` — it
deliberately avoids `instanceof` so it survives bundle boundaries, which is a genuinely good detail — along
with its `plugins/errorHandler.ts`.

## 8.4 Additional hardening

**External clients are lazily initialised**, so a missing API key degrades a feature rather than crashing
boot. Establish the pattern now — see `booking-for-all\apps\server\src\utils\stripe-client.ts`, which was
added after exactly that boot crash — even though Phase 0 has no external clients yet.

CORS is restricted to `APP_BASE_URL`, not `origin: true`, which `booking-for-all` shipped alongside
`credentials: true`. No `/debug/*` or `/api/test-email` routes are created, in any environment.

---

# 9. Web — `apps/web`

Minimal but correctly wired: App Router, TypeScript, Tailwind 4, shadcn/ui initialised, a TanStack Query
provider, `next-intl` with `en` and `hu` message files, a PWA `manifest.json`, Sentry, a placeholder `/`
route, and `/api/health`.

The service worker, tenant routing (`/[tenantSlug]/…`), and the booking flow belong to Epic 2 and later.

Localisation is scaffolded now rather than retrofitted. `sunshine-dental\apps\web\src\locales\{en,hu,de}\*.json`
— 42 files across 14 namespaces, with natively reviewed Hungarian and German — is the source to port from in
a later phase, together with its `interpolation.defaultVariables` technique that injects tenant branding into
every string.

---

# 10. Worker — `apps/worker`

A BullMQ worker skeleton. With no `REDIS_URL` configured it logs

```text
worker: idle — REDIS_URL not configured
```

and stays alive, so the exit criterion "all applications run locally" holds honestly. When `REDIS_URL`
appears in Epic 5, queues and processors attach here.

---

# 11. Observability — `packages/observability`

Pino structured logging carrying the context fields from technical-implementation.md §36.1 — `requestId`,
`tenantId`, `userId`, `sessionId`, `module` — with **redaction paths configured from day one** for
`authorization`, `cookie`, `password`, `*.token`, and `DATABASE_URL`. Never log connection strings.

Sentry initialisation helpers for all three applications. `instrument.ts` is imported first in `server.ts`,
as `sunshine-dental\apps\api\src\instrument.ts` does. Only genuine 5xx responses are reported.

---

# 12. Conventions — `CLAUDE.md`

A short, enforceable conventions file at the repository root, so later phases inherit it. Each item traces to
a specific predecessor failure.

1. Migrations are the only path to schema change; never `db push` a shared database.
2. Every route is schema-first; `as any` on request parts is a review failure.
3. Environment is parsed once at the edge; no scattered `process.env` access.
4. External clients initialise lazily; a missing key degrades a feature, never crashes boot.
5. `tenantId` is a required parameter on every repository call, never optional
   (technical-implementation.md §34.2).
6. Never log connection strings, tokens, or personal data.
7. No debug endpoints, in any environment.
8. Business logic lives in services and engines, not in route handlers.

---

# 13. Testing

Vitest across the API and packages. One meaningful test per workspace, to prove the wiring:

- `packages/config` — the environment schema rejects a missing `DATABASE_URL` with a readable message.
- `packages/db` — migrations apply to a clean `booking_and_more_test` database; `btree_gist` is present.
- `apps/api` — `fastify.inject()` against `/health/live` and `/health/ready`; the error envelope shape;
  a route receiving a malformed body returns 422 in the standard envelope.

Playwright is configured but has no specifications yet. Epic 4 owns the first end-to-end path.

---

# 14. CI Pipeline

`.github/workflows/ci.yml`, per technical-implementation.md §40:

```text
install
  → format check
  → lint
  → typecheck
  → unit tests
  → postgres:18 service container
  → migrate deploy
  → drift check
  → integration tests
  → build api, worker, web
```

The **drift check** is the step that would have prevented `booking-for-all`'s worst incident.

All three predecessor repositories have effectively no CI — one Sentry-release workflow between them. This
pipeline is the single highest-leverage deliverable in the phase.

---

# 15. Deployment Artifacts

Written now, run in production only:

- `docker/Dockerfile.api`, `Dockerfile.web`, `Dockerfile.worker` — multi-stage, using `turbo prune`, running
  as a non-root user, with a healthcheck. None of the predecessors did any of these; theirs were
  single-stage, `COPY . .`, root, no healthcheck.
- `docker/docker-compose.yml` — postgres, redis, and the three applications, for Coolify on Hetzner.

---

# 16. Version Control

`git init`, a `.gitignore`, and one initial commit.

Explicitly ignored, each because a predecessor committed it: `node_modules`, `.env*` except `.env.example`,
`.next`, `dist`, `.turbo`, the generated Prisma client, `openapi.json`, `*.log`, `.idea`, `__pycache__`.

---

# 17. Critical Files

New, in dependency order:

```text
pnpm-workspace.yaml
turbo.json
tsconfig.base.json
packages/config/src/env.ts
packages/db/prisma/schema.prisma
packages/db/prisma/migrations/*_enable_extensions/migration.sql
packages/contracts/src/errors.ts
packages/observability/src/logger.ts
apps/api/src/app.ts
apps/api/src/plugins/*.ts
apps/api/src/modules/health/*
apps/web/app/layout.tsx
apps/worker/src/worker.ts
.github/workflows/ci.yml
CLAUDE.md
```

Read before writing code: [technical-implementation.md](technical-implementation.md) §4, §6, §7, §15, §40,
§42, §43, and `c:\devs\prods\booking-for-all\docs\deployment-fixes-2026-07-27.md`.

---

# 18. Verification

```bash
# 1. Install and build
pnpm install
pnpm build                                  # turbo builds all three apps and packages

# 2. Database — native PostgreSQL 18 on :5432
createdb booking_and_more                   # and booking_and_more_test
pnpm db:migrate                             # applies extensions, then tenants
pnpm db:seed                                # sunshine-dental demo tenant
psql -d booking_and_more -c "\dx"           # expect btree_gist, citext
psql -d booking_and_more -c "select slug, status from tenants;"

# 3. Run all three applications
pnpm dev
curl http://localhost:3001/health/live      # {"status":"ok"}
curl http://localhost:3001/health/ready     # postgres: ok, redis: not_configured
open http://localhost:3001/docs             # OpenAPI UI renders the health routes
open http://localhost:3000                  # Next.js placeholder, hu/en switch works
# worker logs: "worker: idle — REDIS_URL not configured"

# 4. Quality gates — these are the CI steps
pnpm lint && pnpm check-types && pnpm test
pnpm db:drift-check                         # prisma migrate diff, exit code 0
```

## 18.1 Negative checks

The conventions must actually bite:

- Unset `DATABASE_URL` — the API exits immediately, naming the missing variable.
- Stop the PostgreSQL service — `/health/ready` returns 503 while `/health/live` still returns 200.
- POST a malformed body to a schema-bearing route — 422, in the `{ error: { code, message, requestId } }` form.
- Grep the logs for the database password — no hits.

## 18.2 Verified results

Run on 2026-07-28 against native PostgreSQL 18.3.

| Check                                 | Result                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build` / `lint` / `check-types` | 11/11 turbo tasks pass                                                                                                    |
| `pnpm test`                           | 38 tests pass (config 8, contracts 9, observability 5, db 5, api 16, worker/web none yet)                                 |
| Extensions                            | `btree_gist`, `citext` present; a live `EXCLUDE USING gist` constraint accepts back-to-back bookings and rejects overlaps |
| `pnpm db:drift-check`                 | Clean; **and** correctly fails when `schema.prisma` is edited without a migration                                         |
| `GET /health/live`                    | 200                                                                                                                       |
| `GET /health/ready`                   | 200, `postgres: ok`, `redis: not_configured`                                                                              |
| `GET /docs/`                          | 200; `/docs/openapi.json` documents the health routes with real response schemas                                          |
| Web `/hu`, `/en`                      | Both prerendered; locale switch works; `/api/health` 200; PWA manifest 200                                                |
| Worker without `REDIS_URL`            | Logs `worker: idle — no queues attached` and stays alive                                                                  |
| Missing `DATABASE_URL`                | Exits immediately naming the variable, pointing at `.env.example`                                                         |
| Unreachable database                  | `/health/ready` → 503 `degraded`; `/health/live` → 200; process does **not** crash on boot                                |
| Secret leakage                        | No password or connection string in any log line or HTTP response                                                         |

## 18.3 Definition of done

`pnpm dev` brings up all three applications; both health endpoints behave correctly including the degraded
cases; `pnpm lint && pnpm check-types && pnpm test` is green; the drift check passes; the initial commit is
in place.

---

# 19. Explicitly Out of Scope

| Deferred to | Work                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Epic 1      | Better Auth, tenants, memberships, roles, permissions, tenant context, invitations, audit logging |
| Epic 2      | Providers, services, locations                                                                    |
| Epic 3      | Availability engine                                                                               |
| Epic 4      | Holds, capacity reservations, exclusion constraints, bookings                                     |
| Epic 5      | Transactional outbox, BullMQ, Redis, email notifications                                          |
| Epic 6      | Google Calendar                                                                                   |
| Epic 7      | Chat booking                                                                                      |
| Epic 8      | Push-to-talk voice                                                                                |
| Epic 9      | Subscriptions, quotas, platform administration                                                    |
| Epic 10     | Production hardening                                                                              |
