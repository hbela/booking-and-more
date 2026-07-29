# booking-and-more — working conventions

Multi-tenant, voice-enabled booking SaaS. Specs live in [docs/PRD.md](docs/PRD.md) and
[docs/technical-implementation.md](docs/technical-implementation.md).

Phase records: [Phase 0 — foundation](docs/phase-0-technical-foundation.md) ·
[Phase 1 — auth and tenancy](docs/phase-1-authentication-and-tenancy.md) ·
[Phase 2 — providers, services, locations](docs/phase-2-providers-services-locations.md) ·
[Phase 3 — availability engine](docs/phase-3-availability-engine.md) ·
[Phase 4 — booking engine](docs/phase-4-booking-engine.md). Next up is Epic 5 (notifications).

Cite spec sections in code comments as `// tech-impl §11.3` when implementing something the spec pins down.

## Stack

pnpm workspace + Turborepo · Fastify 5 (`apps/api`) · Next.js 16 App Router (`apps/web`) ·
BullMQ worker (`apps/worker`) · PostgreSQL 18 + Prisma 7 · Better Auth 1.6 · Zod 4 · Vitest 4.

TypeScript is pinned to **5.9.x**. TS 7 exists, but `typescript-eslint@8` declares `typescript <6.1.0`, so
upgrading silently disables type-aware linting. Revisit when typescript-eslint supports TS 7.

Local dev runs against **native PostgreSQL 18 on :5432**. There is no Docker on the dev machine and no Redis
until Epic 5 — see the phase plan for why, and for the Testcontainers deviation that follows from it.

## The rules

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
   (tech-impl §34.2). A client-supplied tenant ID is a _hint_ that selects which tenant to look up; access
   always comes from an ACTIVE membership resolved server-side by `tenant-context.plugin.ts`. A tenant the
   caller cannot see returns the same 404 as one that does not exist.

6. **Never log connection strings, tokens, or personal data.** Redaction paths are configured in
   `@bam/observability`; add to them rather than hand-scrubbing at call sites.

7. **No debug endpoints, in any environment.** A predecessor shipped `/debug/db-info`, `/debug/email-config`
   and `/api/test-email` to production.

8. **Business logic lives in services and engines, not route handlers.** Handlers validate, delegate, and
   serialize. The availability and booking engines stay pure — no Fastify, Prisma, Redis or HTTP imports —
   so they stay property-testable (tech-impl §13, §14). `@bam/auth/policy` already follows this: every
   authorization rule is a pure function, and route guards only call them.

9. **A role belongs to a membership, never to a user.** The same person can own one clinic and assist at
   another. `PLATFORM_ADMIN` is the sole exception and is deliberately a user flag rather than a role, so it
   cannot be granted by invitation — set it with `pnpm db:grant-platform-admin <email>`.

10. **Ask for a permission, not a role.** `requirePermission(Permissions.MEMBER_MANAGE)`, never
    `if (role === "ADMIN")`. Re-scoping a role should mean editing one table in `@bam/auth`, not auditing
    every route.

11. **Catalogue rows are archived, never deleted.** `DELETE /v1/services/:id` sets `archivedAt` and clears
    `active`; nothing in providers, services or locations is hard-deleted through the API. A predecessor
    deleted services outright and left bookings pointing at rows that no longer existed, so every screen
    joining through one had to cope with a null it was never designed for. `active` and `archivedAt` are
    different questions — "off for now" and "gone" — and both are needed.

12. **Public responses are their own types.** `/v1/public/*` serialises through schemas declared separately
    in `catalogue.schemas.ts`, not the staff schemas with a filter applied, so adding a staff field cannot
    quietly publish it. What a stranger may see is decided by one class (`PublicCatalogueService`), and every
    query there carries the same active/archived/assigned predicate.

13. **A schedule is wall-clock; an exception is an instant.** `working_hours` stores local `HH:mm` strings,
    never timestamps — "Mondays 09:00–17:00" has to stay 09:00–17:00 on the Monday the clocks change, and a
    stored UTC offset is right for half the year and an hour wrong for the other half (tech-impl §13.4).
    `availability_exceptions` stores `timestamptz`, because it names actual moments. Never convert a
    recurring time by adding an offset by hand; go through `@bam/availability-engine`'s `zone.ts`, which
    reports whether a reading was skipped or repeated by a daylight-saving transition.

14. **The database decides who got the slot.** Exclusive capacity is enforced by one exclusion constraint on
    `capacity_reservations` (tech-impl §11.3), never by a `SELECT` before an `INSERT` — between the check and
    the write there is a window, and under load somebody is always inside it. Application code's job is to
    translate `23P01` into `SLOT_NO_LONGER_AVAILABLE`, not to attempt the decision. The same applies to any
    future exclusive resource: put it in that table rather than inventing a second mechanism.

15. **A booking records what the customer was told.** `customer_name_snapshot`, `service_name_snapshot`,
    `price_minor_snapshot` and `currency_snapshot` are copied at confirmation, never joined for. Rule 11
    keeps catalogue rows alive so the foreign keys resolve, which fixes referential integrity and nothing
    else — a service renamed and repriced next year would otherwise have an old booking claim the customer
    agreed to a price they never saw. Build them through `@bam/booking-engine`'s `buildBookingSnapshot`,
    which also enforces that a price and its currency travel together.

16. **Writes that a customer can retry carry an `Idempotency-Key`.** Holds, confirmations, reschedules and
    cancellations (tech-impl §32). The key is claimed _before_ the work runs, so a retry that arrives
    mid-flight is told the first request is still going rather than doing the work twice. Never make the
    header optional "for now": it is absent exactly when it matters.

## Layout

```
apps/api          Fastify. buildApp() in app.ts is the composition root; server.ts only loads env + listens.
apps/web          Next.js App Router.
apps/worker       BullMQ. Idles cleanly while REDIS_URL is unset.
packages/auth     Roles, permissions, pure policy functions, Better Auth factory.
packages/availability-engine  Pure slot generation. No runtime dependencies, deliberately.
packages/booking-engine  Pure booking decisions: spans, hold lifecycle, state machine, policy.
                         The transaction is the API's; the database owns the race.
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
pnpm db:grant-platform-admin <email>   # the only way to set isPlatformAdmin
```

## Identity vs. authorization

Better Auth owns identity only — users, sessions, credentials. Tenancy, roles and permissions are ours. We
deliberately do not use its `organization` plugin; see
[the phase 1 record §2](docs/phase-1-authentication-and-tenancy.md) for why, and for what went wrong in the
predecessor project when two role systems coexisted.

## Definition of done

Per tech-impl §47: merged, types pass, unit tests exist, integration tests where relevant, tenant isolation
verified, standard error format, request context in logs, no sensitive data logged, API contract documented,
localization keys added, accessibility reviewed, audit events for important writes.
