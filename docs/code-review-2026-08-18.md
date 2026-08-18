# Booking and More — code review

Date: 2026-08-18  
Reviewed state: current working tree, including the uncommitted availability and diary-delegation changes present at review time  
Scope: `apps/api`, `apps/web`, `apps/worker`, all workspace packages, Prisma schema and migrations, CI, and deployment configuration

## Executive summary

The codebase has a strong foundation: domain decisions are separated from I/O, tenant checks are generally explicit, booking capacity is protected by database constraints, sensitive tokens are normally hashed, the outbox pattern is used consistently, and the test suite covers many hard timezone, concurrency, and authorization cases. A forced, non-cached run of linting, type checking, and tests passed across all workspaces.

I would not call the current build production-ready yet. There are five high-priority correctness/security issues:

1. The new working-hours fingerprint check can still lose concurrent edits.
2. A notification left in `SENDING` by a crashed worker is never recoverable.
3. Idempotency records never actually expire and can retain raw management tokens indefinitely.
4. The no-email-provider fallback writes invitation and booking-management links to logs.
5. Stripe events have no durable claim or event-order guard, allowing duplicate side effects and stale state under overlap or multiple workers.

The dependency audit also reports eight high-severity advisories, including runtime paths through Next/Sharp/PostCSS and Fastify's URI parser. These should be resolved before deployment.

### Severity

- **P0 — critical:** immediate compromise or widespread irreversible data loss. None confirmed.
- **P1 — high:** fix before production; credible security exposure, lost updates, stuck delivery, or billing corruption.
- **P2 — moderate:** important reliability, privacy, operability, or maintainability gap.
- **P3 — low:** hardening or quality improvement with limited immediate impact.

## Findings

### P1. Working-hours optimistic concurrency does not serialize competing saves

Evidence: `apps/api/src/modules/availability/availability.repository.ts:119-157`

`replaceWorkingHours` reads the current rows, compares a fingerprint, then deletes and recreates the set in a default `READ COMMITTED` transaction. The accompanying comment concludes that two writers seeing the same fingerprint are not in conflict. That conclusion is incorrect: two editors can read the same starting week and produce different full-week bodies.

Example:

1. Alice and Bob both read fingerprint F0.
2. Alice adds a Monday period; Bob changes Tuesday.
3. Both transactions read F0 before either commits, so both pass.
4. Depending on statement timing, the later delete can erase the first replacement, or the two replacement sets can be combined. Neither result preserves whole-set replacement semantics.

This defeats the feature's stated purpose and can silently lose delegated diary edits.

Recommendation:

- Lock one stable row before reading the schedule, for example the provider row selected by `(tenantId, providerId) FOR UPDATE`, then compute the fingerprint and replace the week while holding that lock; or use `SERIALIZABLE` with a bounded retry policy.
- Keep the fingerprint as the user-facing conflict detector, but make the database lock the serialization mechanism.
- Add a true concurrent integration test with two different bodies and a barrier that makes both transactions attempt the same starting fingerprint. Assert exactly one succeeds and the other returns `SCHEDULE_MODIFIED`.

### P1. Notification claims can become permanently stuck in `SENDING`

Evidence:

- `apps/worker/src/notifications/notification.sender.ts:61-74,182-200`
- `apps/worker/src/notifications/notification.sweeper.ts:53-64`
- `packages/db/prisma/schema.prisma:1440-1451`

The sender atomically changes `PENDING` to `SENDING`, but the notification model records no claim timestamp and the sweeper selects only `PENDING`. If the worker is killed after claiming—before sending, during the provider call, or before recording the result—the row remains `SENDING` forever. BullMQ redelivery does not help: the next sender cannot claim it and returns `NOT_CLAIMED`.

The comment says incrementing `attempts` at claim time prevents an endless crash loop, but there is currently no loop at all after the first crash; the message is simply abandoned. This is especially serious for owner/provider invitations and booking confirmations.

Recommendation:

- Add `claimedAt` (and optionally `claimedBy`) to notifications.
- Reclaim stale `SENDING` rows in the sweeper, subject to the attempt limit, just as outbox and calendar rows are reclaimed.
- Treat the provider-call boundary explicitly. A crash after the provider accepted a message but before the database update can cause a duplicate after reclaim; use a stable provider idempotency key where supported and document the remaining at-least-once behavior.
- Add tests for a stale `SENDING` row and for a simulated crash at each boundary.

### P1. Idempotency expiry is written but never honored or cleaned up

Evidence:

- `apps/api/src/lib/idempotency.ts:42-43,90-138`
- `packages/db/prisma/schema.prisma:1485-1506`

Each key receives an `expiresAt` value, but lookup is an unconditional unique-key `findUnique`; it never checks the expiry. There is no cleanup worker for the table. Consequences:

- A failed operation leaves `responseStatus = null`, so that key returns `IDEMPOTENCY_KEY_IN_PROGRESS` forever rather than for 24 hours.
- A completed key is replayed forever, contrary to `IDEMPOTENCY_TTL_MS` and the comments.
- The table grows without bound.
- Booking-create responses include the raw management token. `withIdempotency` stores the entire response in `responseBody`, so a token otherwise stored only as a SHA-256 hash remains in plaintext indefinitely.

Recommendation:

- Atomically reclaim or replace an expired key before running the operation. Do not implement this as another unguarded read/delete/create sequence.
- Add a recurring deletion job for expired completed and failed keys.
- Explicitly document that sensitive response material is retained for the replay window, and ensure the cleanup SLA matches that window.
- Test replay before expiry, reuse after expiry, failed-operation recovery, and deletion of a response containing a management token.

### P1. The fallback email provider logs live bearer links

Evidence:

- `apps/worker/src/email/email.provider.ts:50-75`
- `apps/worker/src/worker.ts:101-107`
- `packages/config/src/schema.ts:188-200`
- `packages/observability/src/redaction.ts:12-101`

When Resend is not configured, the fallback logs `message.text` as a structured `body`. Invitation and initial booking emails contain raw acceptance or management URLs, so their bearer tokens are written to logs. The redaction policy covers structured fields named `token` and `managementToken`, but not secrets embedded inside `body` strings.

This is described as a development convenience, but email configuration is optional in production and the worker deliberately continues without it. Anyone with log access could accept invitations or manage customer bookings while those links remain valid.

Recommendation:

- Never log complete email bodies in production. Prefer logging template name, notification ID, and a redacted recipient.
- If local preview is needed, gate it explicitly to development and write it to a clearly local-only sink. Redact URL path/query secrets before output.
- Consider refusing production startup when business-critical email is not configured, or surface a degraded readiness state rather than silently marking messages `SKIPPED`.
- Add a logger test using a realistic invitation and booking email and assert neither token appears in serialized output.

### P1. Stripe event processing has neither a durable claim nor ordering protection

Evidence:

- `apps/worker/src/stripe/stripe.processor.ts:76-127`
- `apps/worker/src/stripe/stripe.poller.ts:26-60`
- `apps/worker/src/stripe/stripe.processor.ts:640-652`

`processStripeEventBatch` selects rows with `processedAt: null`, performs side effects, then marks each row processed. There is no `PROCESSING` state, row lock, lease, or compare-and-set update. The interval driver also starts a new batch without checking whether the previous batch is still running. Therefore:

- two worker replicas, or overlapping ticks in one slow process, can process the same event concurrently;
- side effects are not all idempotent—for example, notification requests create new outbox events, and duplicate-subscription detection appends audit rows;
- an older event that previously failed can be retried after a newer event succeeded and overwrite subscription/tenant state with stale data;
- event payload time/version is not recorded on the subscription to reject stale updates.

The primary key prevents duplicate webhook insertion, but it does not prevent duplicate processing of the one stored row.

Recommendation:

- Claim events atomically with `FOR UPDATE SKIP LOCKED` plus a processing lease, or a conditional status transition with `claimedAt`.
- Prevent overlapping local poller runs even after database claiming is added.
- Store/compare the relevant Stripe event creation timestamp (and define tie-breaking) before mutating mirrored state.
- Make every generated side effect use a deterministic dedupe key derived from the Stripe event ID.
- Add multi-worker and out-of-order event tests.

### P1. Current dependency graph contains known high-severity vulnerabilities

Evidence: `corepack pnpm audit --prod --audit-level high` on 2026-08-18 reported 10 advisories: 8 high and 2 moderate.

High-severity results include:

- `sharp 0.34.5` via Next, vulnerable through bundled libvips ([GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj));
- `postcss 8.4.31` via Next, including arbitrary source-map file reads ([GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849));
- `fast-uri 4.1.1` via Fastify/fast-json-stringify and `3.1.4` via Swagger, vulnerable to host confusion ([GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7));
- `deepmerge-ts 7.1.5`, `brace-expansion 5.0.8`, and `nanoid 3.3.16` on transitive paths.

Some findings may only be reachable during build/tooling, while Sharp, PostCSS, and Fastify paths are part of deployed applications. Applicability should be confirmed, but a high advisory should not be waived merely because it is transitive.

Recommendation:

- Update direct dependencies/lockfile until the runtime paths resolve to patched versions.
- Add `pnpm audit --prod` (with an explicit severity policy and a documented exception mechanism) to CI.
- Build and smoke-test all three production images after upgrading, especially image optimization and API schema handling.

### P2. `/v1/me` converts every tenant-resolution failure into an empty-access success

Evidence: `apps/api/src/modules/me/me.routes.ts:132-162`

The route catches every exception from `resolveTenantContext` and returns a 200 response with no tenant, membership, or permissions. This includes expected “no tenant selected” cases, but also database outages, programming errors, suspended memberships, and malformed tenant state. The UI then looks like a valid signed-in user simply has no access, masking incidents and producing misleading empty screens.

Recommendation:

- Distinguish the expected no-selection/no-membership conditions by error code.
- Re-throw infrastructure errors and unexpected exceptions so normal logging, Sentry, and 5xx behavior apply.
- Return suspended/closed state deliberately if the UI needs to render a billing or support path.
- Add a test in which tenant lookup fails and assert the endpoint does not return a successful empty profile.

### P2. Rate limiting is both per-process and based on an over-trusted proxy chain

Evidence: `apps/api/src/app.ts:137-155,207-215`

Fastify is configured with `trustProxy: true`, so deployments that permit direct access or preserve a caller-supplied `X-Forwarded-For` can let a client influence `request.ip`, the usual rate-limit key. The limiter uses its default in-memory store even though Redis is already present in the production topology. Limits therefore reset on restart and multiply with every API replica.

Recommendation:

- Trust only the known proxy hop/CIDR and verify how Traefik rewrites, rather than appends, forwarded headers.
- Back public/auth/write limits with Redis and use namespaced keys.
- Add an integration test showing spoofed forwarded headers do not create fresh rate-limit identities.

### P2. Required retention cleanup is declared but not implemented

Evidence:

- `docs/technical-implementation.md:2288-2312`
- `apps/worker/src/queues.ts:14-22`
- `apps/worker/src/worker.ts:25-43`

The technical design requires cleanup of old idempotency keys, completed outbox rows, expired sessions/holds, management tokens, and other retained data. The queue name exists, but no retention worker is attached. Beyond storage growth, this leaves secrets and personal data in idempotency responses, notification payloads, Stripe payloads, booking snapshots, and operational logs longer than the stated policy.

Recommendation:

- Implement and test a bounded, observable retention job with per-table policies.
- Separate operational evidence that must be retained from replayable secrets that must be removed quickly.
- Record counts, duration, and oldest remaining eligible row; alert on repeated cleanup failure.
- Revisit whether raw Stripe payloads and failed/SKIPPED notification payloads need indefinite retention.

### P2. Bearer credentials in URL paths are not redacted from request telemetry

Evidence:

- `apps/api/src/modules/public/booking.routes.ts:235-400`
- `apps/api/src/app.ts:137-155`
- `packages/observability/src/redaction.ts:12-101`
- `apps/api/src/plugins/error-handler.plugin.ts:124-130`

Booking management tokens appear directly in API paths. Fastify request logging and upstream access logs normally record request URLs; the redaction list covers a structured `managementToken` property but not `req.url`. The not-found response also reflects the full `request.url`. As a result, a typo or serialization failure can copy a live management credential into application logs, Sentry context, proxy logs, and client-visible error text.

Bearer links are a reasonable customer UX, but every logging layer must treat their path segments as secrets.

Recommendation:

- Redact or normalize known secret-bearing routes before request logging and error reporting (for example `/bookings/[redacted]`).
- Configure Traefik/access-log filtering consistently.
- Do not echo the raw URL in 404 messages.
- Add tests around application logger output; document unavoidable browser-history/referrer exposure and set an appropriate `Referrer-Policy`.

### P2. Web security headers are incomplete

Evidence:

- `apps/web/next.config.ts:12-19`
- `apps/web/src/components/theme-script.tsx:60-65`

The API uses Helmet, but the browser-facing Next app defines no CSP or other explicit response-header policy. It emits an inline theme script with `dangerouslySetInnerHTML`, so adding CSP later will require a nonce/hash design. React escaping reduces XSS likelihood but is not a substitute for browser-level containment.

Recommendation:

- Add CSP, `Referrer-Policy`, `Permissions-Policy`, frame protection (`frame-ancestors`), and a deliberate HSTS policy at the web/proxy layer.
- Use a nonce or stable hash for the theme bootstrap script.
- Add a production response-header smoke test.

### P2. The green test result excludes the parked calendar integration and has no browser-level UI coverage

Evidence:

- `apps/api/src/integrations.test.ts:202`
- `apps/worker/src/calendar/calendar.leg.test.ts:73`
- `apps/api/src/app.ts:344-387`
- `apps/worker/src/worker.ts:128-191`

The forced suite passed, but 34 API integration tests and 15 calendar-leg tests are skipped because Google Calendar is parked. The web package tests utilities and CSS contrast but has no component interaction or end-to-end browser tests for sign-in, tenant selection, booking, cancellation, delegation, or schedule conflict handling.

Recommendation:

- Keep parked tests visibly reported and require them to pass before the feature is mounted.
- Add a small browser suite for the highest-value flows and keyboard/focus behavior.
- Add regression tests specifically for the P1 worker and concurrency cases above.

### P3. The worker healthcheck cannot detect a wedged worker

Evidence: `docker/Dockerfile.worker:43-47`

The healthcheck starts a separate Node process that always exits zero. Docker already knows whether PID 1 has exited, so this adds no information about queue connectivity, poller progress, database connectivity, or an event loop that is alive but no longer doing work.

Recommendation:

- Emit a durable heartbeat for each critical loop and have the healthcheck fail when it is stale, or expose a small internal-only health endpoint.
- Distinguish liveness from readiness/degraded state (for example Redis absent, notification sender disabled, Stripe poller stalled).

### P3. Formatting is not currently clean

`corepack pnpm format:check` fails and reports 86 files. Because formatting is a required CI step, the current working tree would fail CI despite lint/type/test success. Many files were already modified before this review; no formatting changes were made as part of the review.

## Positive observations

- Tenant scoping and resource-specific authorization are unusually explicit, and the tests cover cross-tenant and delegated-diary cases well.
- Booking capacity uses PostgreSQL exclusion/uniqueness constraints rather than relying on read-before-write checks.
- The pure availability and booking engines have strong unit and property coverage, including DST and non-hour timezone transitions.
- Outbox records, notification dedupe keys, and deterministic calendar event IDs show good awareness of at-least-once delivery.
- Secrets are generally hashed or encrypted at rest; CORS is allow-listed; request bodies are bounded; schemas drive validation and serialization.
- CI provisions real PostgreSQL, checks migration drift, applies migrations from scratch, and runs build/type/lint/test gates.
- Docker images run as a non-root user and keep `.env` files out of the build context.

## Validation performed

- Forced, non-cached `turbo run lint check-types test --force`: **passed**, 49 tasks, 0 cached.
- API: **315 tests passed, 34 skipped** (parked calendar integration).
- Worker: **113 tests passed, 15 skipped** (parked calendar leg).
- All other package test tasks in the forced run passed.
- `pnpm format:check`: **failed**, 86 files reported.
- `pnpm audit --prod`: **failed policy check**, 8 high and 2 moderate advisories across 605 dependencies.
- Static review covered API routes/services/repositories/plugins, web routes/components/client utilities, worker pollers/processors/sweepers, domain packages, Prisma schema/migrations, observability, CI, and Docker/Coolify configuration.

## Suggested remediation order

1. Serialize working-hours replacement and add the concurrent regression test.
2. Make notification claims recoverable and stop logging message bodies/tokens.
3. Make idempotency expiry real and deploy retention cleanup.
4. Claim/order Stripe events and dedupe their downstream effects.
5. Upgrade vulnerable dependencies and rebuild/smoke-test production images.
6. Tighten proxy/rate-limit and URL-redaction behavior.
7. Narrow `/v1/me` error handling and add browser-level critical-flow tests.
8. Clean formatting once the current feature branch's source changes are settled.
