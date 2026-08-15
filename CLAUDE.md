# booking-and-more — working conventions

Multi-tenant appointment-booking SaaS. Specs live in [docs/PRD.md](docs/PRD.md) and
[docs/technical-implementation.md](docs/technical-implementation.md) — both still describe it as
voice-enabled, which it deliberately is no longer: see the withdrawal note below Phase 10.

Phase records: [Phase 0 — foundation](docs/phase-0-technical-foundation.md) ·
[Phase 1 — auth and tenancy](docs/phase-1-authentication-and-tenancy.md) ·
[Phase 2 — providers, services, locations](docs/phase-2-providers-services-locations.md) ·
[Phase 3 — availability engine](docs/phase-3-availability-engine.md) ·
[Phase 4 — booking engine](docs/phase-4-booking-engine.md) ·
[Phase 5 — notifications](docs/phase-5-notifications.md) (part 1 of 3: outbox dispatch, queues, the
notification record. Email delivery was built early by Epic 9; the booking half of parts 2 and 3 is the
record below) ·
[Phase 5 — booking notifications](docs/phase-5-booking-notifications.md) (the five booking emails, and the
sweep that makes a reminder fire; done). It closes phase-4 §5.2 and phase-5 §5.1/§5.2. **Read its §2.1
before putting a link in any email**: the management token is stored only as a hash, so it travels in the
outbox payload and reaches exactly two of the five templates — and §2.2 records why the reminder is
deliberately not one of them ·
[Phase 6 — booking calendar](docs/phase-6-booking-calendar.md) (the customer's month view only; the staff
calendar, Google Calendar sync and per-step deep links are still Epic 6's and still unbuilt — its §6 says so
explicitly). The "When" step was a date input and a list, so an empty day was a dead end. **Read its §2.2
before widening or narrowing any slot search**: it reverses phase 4's "never widen the search", with the
measurement that justifies it, and §2.2.1 records why `@fastify/compress` arrived with it and why
`requestEncodings` must stay untouched. §2.4 is the one that bites — a day's count is *distinct start times*,
because the search merges providers without deduplicating. §2.7 is two zones on one screen on purpose: a slot
is an instant in the reader's zone, a calendar cell is a zoneless square formatted in UTC ·
[Phase 9 — SaaS administration](docs/phase-9-saas-administration.md) (part plan, part record: provisioning,
the owner's invitation and its email are built; Stripe, the pending owner dashboard and the expiry sweep are
not — its §1.2 is the authority on which is which) ·
[Phase 9 — owner onboarding](docs/phase-9-owner-onboarding.md) (the owner's path from the emailed link to a
signed-in session — accept-and-register, the invitation landing page; done) ·
[Phase 9 — subscription and activation](docs/phase-9-subscription-and-activation.md) (the pending owner's
dashboard, the emailed Stripe Payment Link, the webhook that activates; done). Its §7 **amends** the
decision record's §5.1: a Payment Link rather than Stripe Checkout, because a Checkout Session expires in
24 hours and the subscribe window is 14 days ·
[Phase 9 — customer portal](docs/phase-9-customer-portal.md) (self-service billing once a subscription
exists: change the card, read invoices, cancel; done). Its §3 is the one to read before touching the Stripe
event processor — a portal cancellation may report `cancel_at` rather than `cancel_at_period_end`, and a
plan the event does not name is left alone rather than guessed ·
[Phase 9 — subscription lifecycle](docs/phase-9-subscription-lifecycle.md) (the 30-day trial, plan changes,
scheduled downgrades, failed payments; done). **Read §3 before changing anything about access:** the whole
entitlement rule is one table in `@bam/contracts`, and two refusals constrain it — a Stripe event may
suspend an organization but never revive one, and `past_due` keeps access because Stripe's own dunning is
the grace period ·
[Phase 9 — duplicate subscription prevention](docs/phase-9-duplicate-subscription-prevention.md) (done bar
§5.3's reconciliation sweep and §6's manual walk against Stripe). One organization reached three live Stripe
subscriptions. It **reverses §1.2 of the activation record**: a Payment Link is now created per
organization at subscribe time, not held in config per plan, so the four `STRIPE_PAYMENT_LINK_*` variables
are gone and `STRIPE_PRICE_*` decides what is sold. **Read its §2 before touching `requestPaymentLink` or
`activate`** — three defects, and the reported one is not the worst ·
[Phase 9 — owner onboarding emails](docs/phase-9-owner-onboarding-emails.md) (done). Why configured email
delivered nothing — the worker memoises its provider at boot, so keys added later need a restart — and the
`SUBSCRIPTION_CONFIRMED` email that closes the loop the payment link opens. Its §2 is the one to read: an
`EmailProvider` that does not deliver must not report success, because `status: SENT` with a null
`provider_message_id` is the predecessor's swallowed-failure bug wearing a different hat ·
[Phase 9 — owner language and return paths](docs/phase-9-owner-language-and-return-paths.md) (done). The
platform form never asked what language an organization speaks, so every owner was onboarded in Hungarian —
and every URL built server-side omitted the locale segment, which is invisible while Hungarian is the
unprefixed default. **`buildAppUrl` in `@bam/contracts` is now the only way to build a link to one of our own
screens**; its §5.2 records why the Stripe payment page's language is _not_ settable and is not going to be ·
[Phase 9 — manual test checklist](docs/phase-9-manual-test-checklist.md) (written, **not yet walked**). The
one document to open before testing onboarding or billing by hand: preconditions, ~60 checks from
provisioning to cancellation, and the Stripe-side assertions no automated test can make ·
[Phase 9 — provider onboarding](docs/phase-9-provider-onboarding.md) (done bar its §6 manual walk). The
Providers screen can now give a provider a login: one row action issues an invitation carrying the diary,
emails it, and acceptance links the membership in the same transaction that burns the token. Closes
phase-2-3 §5.11. **Read its §2.7 before touching `claimInvitation`** — the link is made _inside_ the
acceptance transaction, and the unique index that decides the race is also what leaves the invitation
PENDING for a second try. Its §2.9 is why a `PROVIDER` now sees three navigation items rather than seven ·
[Phases 2–3 — owner management](docs/phase-2-3-owner-management.md) (done bar its §6.2 manual walk). The
catalogue and availability screens were create-only, and two of them destroyed data on every save. **Read its
§2 before touching any whole-set `PUT`** — the rule is that such a body may only be built from a full read of
that same set, and it is enforced structurally rather than remembered. Its **§2.7 removes
`service_locations`**, the service↔location link §2.4 had added hours earlier: a location is one of the
organization's sites and nothing more, and where a service is offered follows from where a provider who
offers it works. Read §2.7 before re-reading PRD §9.4/§9.5, which still specify the link and are now a
recorded deviation. §2.6 is the other half of the same decision — **who decides what**: the owner configures
the catalogue and each provider's base location, and **availability belongs to the provider**. Also closes
phase-2 §5.4 and phase-3 §5.6, adds `POST /v1/{providers,services,locations}/:id/restore`, and is why
`apps/web` now depends on `@bam/availability-engine`. ·
[Phase 10 — deployment to Hetzner with Coolify](docs/phase-10-deployment-hetzner-coolify.md) (the guide is
written and the stack is verified locally; the walk on a real VPS is not done — its §9.1 says exactly what
that leaves unproven). Phase 0's Docker files had never been run: all three images failed to build and the
database container could not start at all. **Read its §2.3 before adding anything to `.dockerignore`** —
`incremental: true` leaves `.tsbuildinfo` files that are gitignored but were not dockerignored, so tsc
believed outputs already existed, emitted almost nothing, and exited 0. A Docker build copies the working
tree; CI checks out clean, which is why CI never saw it. §2.4 is the other one that bites: `postgres:18`
**refuses to start** if the volume is mounted at `/var/lib/postgresql/data` rather than one level up. Adds
`docker-compose.coolify.yml` at the root — the Coolify file publishes no host ports, and
`docker/docker-compose.yml` remains the local-parity one that does. **§2.9 is the one to read before
touching the server's network or generating any password**: CERT-Bund found PostgreSQL open to the internet
on 2026-08-04, from something created on the server rather than from either compose file. Two rules come out
of it — **`ufw deny` does not close a published container port** (Docker's DNAT runs before UFW's INPUT
chain, so the control has to be the Hetzner Cloud Firewall), and **a password that goes into a connection
string must be `openssl rand -hex`, never `-base64`**, because a `/` ends the URL's authority and yields a
different host rather than an error. Redis now has a `requirepass`. ·
[Phase 11 — GUI redesign](docs/phase-11-gui-redesign.md) (**in progress**). The app had never had a design
pass: four placeholder teal tokens, no fonts, and a design system that was three exported class-name
_strings_ at the bottom of a feature file. Rebuilt on a deep blue at oklch hue 262, a semantic token layer,
and a real `components/ui/`. **Read its §2.2 before using a colour**: there are two ramps, `brand-*` for
product chrome and `accent-*` for the public booking page, and mixing them throws away the only thing that
makes PRD §9.1 white-labelling a data change later. §2.4 is why `color-scheme` may never be `light dark`
again and why the dark block is deliberately duplicated; §2.5 is why redefining `--color-slate-*` rather
than replacing it is what lets the migration land one screen at a time. **§2.6 lists what must not be
"improved"** — five accessibility decisions with written rationale that a redesign is exactly the moment to
reverse by accident. Google Stitch is used as the visual specification and **its generated HTML is never
shipped** (§2.1).

Phase 9 is out of order deliberately: onboarding gates every other epic's screens, so it was started once
the booking engine existed rather than last. Note that it also delivered the first working email path, ahead
of the booking templates Epic 5 part 2 was scoped around.

**Phases 7 and 8 are withdrawn.** Chat booking and push-to-talk voice were built and then reverted on
2026-08-11, one day after they landed — the classic booking form is the customer path, and the assistant was
a second way to reach the same hold. Their records survive as
[Phase 7 — chat booking (withdrawn)](docs/phase-7-chat-booking.md) and
[Phase 8 — push-to-talk voice (withdrawn)](docs/phase-8-push-to-talk-voice.md), each opening with what was
removed and what to reinstate first if the decision is ever revisited. **Nothing in either is in the codebase
now**: no `@bam/ai`, no `@bam/conversation-engine`, no `/v1/public/conversations`, and no conversation or
usage tables — `20260811120000_remove_conversations_and_usage_metering` drops them. Read the records before
reopening the idea, and treat tech-impl §18–§21 and PRD goal #2 as specified-but-not-built.

Cite spec sections in code comments as `// tech-impl §11.3` when implementing something the spec pins down.

## Stack

pnpm workspace + Turborepo · Fastify 5 (`apps/api`) · Next.js 16 App Router (`apps/web`) ·
BullMQ worker (`apps/worker`) · PostgreSQL 18 + Prisma 7 · Better Auth 1.6 · Zod 4 · Vitest 4.

TypeScript is pinned to **5.9.x**. TS 7 exists, but `typescript-eslint@8` declares `typescript <6.1.0`, so
upgrading silently disables type-aware linting. Revisit when typescript-eslint supports TS 7.

Local dev runs against **native PostgreSQL 18 on :5432**, and keeps doing so: **Docker arrived on the dev
machine on 2026-07-29** (Engine 29.6, Compose v5.3) but nothing has moved into a container. Redis is still
absent until Epic 5, where it can now run locally out of `docker/docker-compose.yml` rather than only in
production.

Docker unblocks — but has not yet cashed in — the Testcontainers deviation recorded in
[the phase 0 record §4.1](docs/phase-0-technical-foundation.md): integration tests still run against a
`booking_and_more_test` database on the native instance, and a `postgres:18` service container in CI. That
record describes the machine as it was in Phase 0; this paragraph is the current state.

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

   **A platform admin holds no memberships.** An operator of the platform is not one of its customers.
   `can()` already returns true for them in every tenant, so a membership grants them nothing — but every
   action they take is audited as `PLATFORM_ADMIN`, so an operator who is also an owner produces a trail in
   which ordinary owner work is indistinguishable from platform intervention. Enforced in **both**
   directions by `canHoldTenantMembership` and `canBecomePlatformAdmin` in `@bam/auth/policy`: tenant
   creation and invitation acceptance refuse a platform admin, and the grant script refuses a user who
   holds memberships. A one-way guard is defeated by doing the two steps in the other order. Use a second
   account for tenant-side work.

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

    **Database sessions run in UTC**, pinned in `createPrismaClient`. Without it `node-postgres` writes a
    JS `Date` as its UTC digits with no offset and PostgreSQL reads that literal in the session timezone,
    so the stored instant is shifted by the local offset. Reads shift back, so Prisma round-trips look
    correct and only comparisons PostgreSQL performs itself — `available_at <= now()`, expiry checks — are
    wrong, by a different amount in summer and winter. `packages/db/src/timezone.test.ts` asserts through
    `extract(epoch …)` rather than through Dates, because comparing Dates is what hid it.

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
packages/notification-engine  Pure notification decisions: what an outbox event owes, dedupe keys,
                         locale resolution, retry classification. Sending lives in the worker.
packages/config   Zod-validated env.
packages/contracts Shared Zod schemas, error codes, API envelope types.
packages/db       Prisma schema, migrations, client singleton.
packages/observability  Pino logger with redaction, Sentry helpers.
```

Every one of those libraries is consumed through its `exports` map, which resolves to `dist/` — never to
`src/`. So each has a `dev` script (`tsc -p tsconfig.build.json --watch`) and `pnpm dev` runs them
alongside the apps. Without it, turbo's `^build` compiles each library exactly once at start-up, and an
export added afterwards does not exist as far as an already-running `next dev` is concerned: Turbopack
reports `Export X doesn't exist in target module` and helpfully suggests a neighbouring export from the
stale build. That is 11 persistent tasks, which is why `turbo.json` raises `concurrency` above its default
of 10. `@bam/db#dev` additionally depends on `@bam/db#build`, because only that runs `prisma generate` and
the watch cannot typecheck without the generated client.

API modules follow tech-impl §6: `<domain>.routes.ts`, `.schemas.ts`, `.handlers.ts`, `.service.ts`,
`.repository.ts`, `.policy.ts`, `.errors.ts`, `.test.ts`.

## Error contract

Every error response is `{ error: { code, message, requestId, details } }` (tech-impl §15.1). Throw
`AppError` subclasses from `@bam/contracts`; the error-handler plugin serializes them. `isAppError` is a
duck-typed flag rather than `instanceof` on purpose — it survives bundle boundaries.

## Commands

```bash
pnpm dev                 # all three apps, plus a tsc --watch per library
pnpm build
pnpm lint && pnpm check-types && pnpm test
pnpm db:migrate          # create/apply a migration
pnpm db:drift-check      # what CI runs
pnpm db:grant-platform-admin <email>   # the only way to set isPlatformAdmin
pnpm db:join-tenant <email> <slug> [ROLE]   # development only; a second membership by hand
pnpm db:discard-organization <slug|domain> [--yes]   # development only; see below
pnpm db:explain-availability <slug> [YYYY-MM-DD] [--service <slug>] [--provider <name>]
```

**`db:explain-availability` is the answer to "the provider has hours but the booking page offers nothing".**
It opens by counting `working_hours` rows per provider, because the nastiest version of that question is a
tenant whose table is *full* while the search reaches a provider who has none: an archived provider still
has an availability screen, and a membership linked to one still saves to it, so the schedule lands
somewhere real and invisible. That first block turns "no working hours here" into "the working hours are
over there".

An empty slot list is the honest answer to a real search that matched nobody, and it is indistinguishable
from a misconfiguration — of which there are eight, spread across four screens. The script walks the same
gates `AvailabilityService.searchSlots` walks, in the same order, and prints what each one decided: the
service's own flags, the provider assignment, the effective notice and advance window after the
most-restrictive rule, whether the working periods are long enough to hold the service *plus its buffers*,
which rows are ignored and why, and finally the verdict from `generateSlots` itself rather than from a
reimplementation. It reads only — no write, no audit row — and so, alone among the scripts here, it does
**not** refuse to run against production: refusing would remove it from the one database whose data is ever
in question. It is a script and not a route because of rule 7.

**There is no `db:seed`.** It created one demo tenant, Sunshine Dental, and was removed on 2026-08-01 along
with that tenant — an ACTIVE organization with no subscription row, which is precisely what phase-9 §2.2's
invariant forbids. A fresh clone therefore starts empty, and an organization comes from the same place a
real one does: `pnpm db:grant-platform-admin` yourself, then provision through `/platform`. That path is now
built end to end, so a hand-written fixture would only be a second, diverging way to make a tenant.

`db:discard-organization` hard-deletes a tenant and everything cascading from it, then any user left with no
memberships — because `slug` and `domain` are unique across all tenants, so a test organization otherwise
blocks re-provisioning the same business forever. It refuses to run with `NODE_ENV=production`, where the
equivalent is closing the organization (phase-9 §2.6) and, if the prospect returns, reopening it (§2.6.1).
It is a script and not a route precisely because of rule 7.

## Identity vs. authorization

Better Auth owns identity only — users, sessions, credentials. Tenancy, roles and permissions are ours. We
deliberately do not use its `organization` plugin; see
[the phase 1 record §2](docs/phase-1-authentication-and-tenancy.md) for why, and for what went wrong in the
predecessor project when two role systems coexisted.

## Definition of done

Per tech-impl §47: merged, types pass, unit tests exist, integration tests where relevant, tenant isolation
verified, standard error format, request context in logs, no sensitive data logged, API contract documented,
localization keys added, accessibility reviewed, audit events for important writes.
