# booking-and-more — working conventions

Multi-tenant, voice-enabled booking SaaS. Specs live in [docs/PRD.md](docs/PRD.md) and
[docs/technical-implementation.md](docs/technical-implementation.md); the current phase plan is
[docs/phase-0-technical-foundation.md](docs/phase-0-technical-foundation.md).

Cite spec sections in code comments as `// tech-impl §11.3` when implementing something the spec pins down.

## Stack

pnpm workspace + Turborepo · Fastify 5 (`apps/api`) · Next.js 16 App Router (`apps/web`) ·
BullMQ worker (`apps/worker`) · PostgreSQL 18 + Prisma 7 · Zod 4 · Vitest 4.

TypeScript is pinned to **5.9.x**. TS 7 exists, but `typescript-eslint@8` declares `typescript <6.1.0`, so
upgrading silently disables type-aware linting. Revisit when typescript-eslint supports TS 7.

Local dev runs against **native PostgreSQL 18 on :5432**. There is no Docker on the dev machine and no Redis
until Epic 5 — see the phase plan for why, and for the Testcontainers deviation that follows from it.

## The eight rules

Each of these is here because a predecessor project (`booking-for-all`, `sunshine-dental`,
`appointer-console`) got it wrong and paid for it.

1. **Migrations are the only path to schema change.** Never run `prisma db push` against a shared database.
   A `db push` plus a backfill script once left a comment-only migration file and a production drift
   incident. CI runs `prisma migrate diff --exit-code`; note that `prisma migrate status` does _not_ catch
   this class of drift.

2. **Every route is schema-first.** Declare `schema: { body, querystring, params, response }` on every route
   via `fastify-type-provider-zod`. `as any` on `req.body` / `req.query` / `req.params` is a review failure —
   a predecessor registered the type provider and then cast everything, which silently killed runtime
   validation, response serialization, and the OpenAPI spec at once.

3. **Environment is parsed once, at the edge.** `@bam/config` owns the Zod schema and fails fast listing every
   missing key. No `process.env` access anywhere else.

4. **External clients initialise lazily.** A missing API key must degrade one feature, never crash boot.
   Wrap Stripe / Resend / OpenAI / Google clients in a `getX()` that constructs on first use.

5. **`tenantId` is a required parameter on every repository call.** Never optional, never inferred from
   ambient state. `bookingRepository.findById({ tenantId, bookingId })`, never `findById(bookingId)`
   (tech-impl §34.2). Client-supplied tenant IDs are validated against membership before use.

6. **Never log connection strings, tokens, or personal data.** Redaction paths are configured in
   `@bam/observability`; add to them rather than hand-scrubbing at call sites.

7. **No debug endpoints, in any environment.** A predecessor shipped `/debug/db-info`, `/debug/email-config`
   and `/api/test-email` to production.

8. **Business logic lives in services and engines, not route handlers.** Handlers validate, delegate, and
   serialize. The availability and booking engines stay pure — no Fastify, Prisma, Redis or HTTP imports —
   so they stay property-testable (tech-impl §13, §14).

## Layout

```
apps/api          Fastify. buildApp() in app.ts is the composition root; server.ts only loads env + listens.
apps/web          Next.js App Router.
apps/worker       BullMQ. Idles cleanly while REDIS_URL is unset.
packages/config   Zod-validated env.
packages/contracts Shared Zod schemas, error codes, API envelope types.
packages/db       Prisma schema, migrations, client singleton.
packages/observability  Pino logger with redaction, Sentry helpers.
```

API modules follow tech-impl §6: `<domain>.routes.ts`, `.schemas.ts`, `.handlers.ts`, `.service.ts`,
`.repository.ts`, `.policy.ts`, `.errors.ts`, `.test.ts`.

## Error contract

Every error response is `{ error: { code, message, requestId, details } }` (tech-impl §15.1). Throw
`AppError` subclasses from `@bam/contracts`; the error-handler plugin serializes them. `isAppError` is a
duck-typed flag rather than `instanceof` on purpose — it survives bundle boundaries.

## Commands

```bash
pnpm dev                 # all three apps
pnpm build
pnpm lint && pnpm check-types && pnpm test
pnpm db:migrate          # create/apply a migration
pnpm db:drift-check      # what CI runs
pnpm db:seed
```

## Definition of done

Per tech-impl §47: merged, types pass, unit tests exist, integration tests where relevant, tenant isolation
verified, standard error format, request context in logs, no sensitive data logged, API contract documented,
localization keys added, accessibility reviewed, audit events for important writes.
