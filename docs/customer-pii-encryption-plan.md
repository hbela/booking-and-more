# Encrypt customer PII at rest — design plan

**Status: proposed, not yet implemented.**

## Context

Customer personal data (`Customer.fullName`/`email`/`phone`, and the `Booking`
snapshot copies of the same — `customerNameSnapshot`/`customerEmailSnapshot`/
`customerPhoneSnapshot`, rule 15) is stored as plaintext in PostgreSQL today. This
project has direct incident history with the database perimeter failing —
[the phase 10 record](phase-10-deployment-hetzner-coolify.md) §2.9 records CERT-Bund
finding PostgreSQL exposed to the internet in production, from something created on
the server outside either compose file. The realistic threat this plan defends against
is exactly that shape: an unauthorized connection to Postgres, or a stolen/leaked
backup — not a compromised application server, since the application is the system
that's authorized to see this data in the first place.

The prompting question was "how do I use PostgreSQL functions/plugins (pgcrypto) to
encrypt this" — this doc explains why that's the wrong layer for this system and
recommends extending the encryption primitive the codebase already has instead.

**Confirmed by codebase research, not assumed:**
- A pure, tested AES-256-GCM sealer already exists: `@bam/crypto`
  (`packages/crypto/src/token-cipher.ts`) — `sealToken`/`openToken`/`parseEncryptionKey`/
  `looksSealed`. Currently used for exactly one thing (Google Calendar OAuth tokens on
  `CalendarIntegration`, a feature that is itself parked/unmounted), but its own docs
  explicitly anticipated reuse: "`@bam/crypto` is general-purpose sealing and is the
  obvious home for any future secret at rest."
- No `pgcrypto` extension is enabled anywhere in this repo (only `btree_gist`,
  `citext`). PostgreSQL is version 18.
- `Customer.email`/`phone` carry **no index** — free to encrypt with zero query impact.
  `Customer.normalizedEmail`/`normalizedPhone` **do** carry
  `@@index([tenantId, normalizedX])` and are used in a live equality lookup —
  `BookingService.upsertCustomer` (`apps/api/src/modules/bookings/booking.service.ts`,
  the *only* place `Customer` rows are read/written) does
  `findMany({ where: { tenantId, OR: [{ normalizedEmail }, { normalizedPhone }] } })`
  on every booking (public form, staff walk-in, **and** the live conversation/AI-intake
  path — contrary to `CLAUDE.md`'s claim that Phases 7–8 left nothing in the codebase,
  `apps/api/src/modules/public/conversation.*` is present, registered, and funnels into
  this exact same call — worth reconciling with `CLAUDE.md` separately from this plan).
  This is the one hard constraint on the design: these two columns must stay
  server-side equality-searchable.
- No case-insensitive/partial search on customer name or email exists anywhere — no
  fuzzy-search requirement to preserve.
- None of the three `Booking` snapshot columns is indexed — free to encrypt.
- Decrypt is needed at exactly five confirmed call sites (§"Application wiring" below)
  — no bulk export/reporting feature exists, so per-row decrypt cost is a non-issue.
- Booking-related `AuditLog` entries (`writeAudit` in `booking.service.ts`) capture only
  `reference`/`status`/`startAt`/`providerId`/`source` — **verified, no customer PII
  reaches the audit trail today**, so this is not an open question, it's confirmed
  clean and out of scope.

**Decisions already made:**
- Rollout: **pre-launch/test data only** → one migration + one backfill script + one
  deploy, not a phased dual-write/cutover/cleanup sequence.
- The two new encryption keys are **required at boot** (not optional-degrading like the
  Google Calendar key pattern) — this is core protection for every tenant, not an
  opt-in third-party integration.
- Scope is **Customer.fullName/email/phone + the three Booking snapshot columns only**.
  `Booking.notes` and `Customer.externalReference` stay plaintext for this pass.
- `Customer.normalizedEmail`/`normalizedPhone` are **renamed** to `emailBlindIndex`/
  `phoneBlindIndex` (mirrors the existing `sealedAccessToken` naming convention) and
  become HMAC digests instead of lowercased plaintext.

## Why not pgcrypto

Two independent, sufficient reasons, both confirmed by research rather than assumed:

1. **Key transit.** `pgp_sym_encrypt`/`pgp_sym_decrypt` take the key as a SQL argument —
   every call that touches these columns would need to carry the key into Postgres,
   either as a bind parameter on ad hoc raw SQL (bypassing Prisma's typed queries, rule
   2's schema-first discipline) or via a session GUC (`SET app.key = ...`), which is
   worse under this repo's Prisma 7 driver-adapter setup: connections are pooled
   through `node-postgres` directly, so a session-level setting can leak across pooled
   connections/requests. Neither improves on "the key lives only in application memory
   and never crosses the wire to Postgres," which is what `sealToken`/`openToken`
   already give you for free.
2. **No searchability win.** `pgp_sym_encrypt`'s default mode is *also*
   non-deterministic (random session key wrapped per call), so it doesn't solve the one
   actually-hard problem in this design (keeping `normalizedEmail`/`normalizedPhone`
   equality-searchable) either. Whatever mechanism solves that — see the blind index
   below — pgcrypto isn't a shortcut past it.

There's no third party in this system with DB access but not application access to
defend against (only `apps/api`/`apps/worker` hold `DATABASE_URL`, and they're also the
only legitimate readers of plaintext PII), so the "trusted-DB/untrusted-app" case where
pgcrypto would genuinely earn its keep doesn't apply here.

Disk/volume-level encryption (Hetzner Cloud Volume encryption or LUKS) is a legitimate,
*orthogonal* control against physical media theft — worth having, but a separate
infrastructure decision, not part of this plan.

## Design

**Sealing** (`sealToken`/`openToken`, unchanged) for display values:
`Customer.fullName`/`email`/`phone` and `Booking.customerNameSnapshot`/
`customerEmailSnapshot`/`customerPhoneSnapshot`. Same AES-256-GCM primitive already in
production-tested use for Calendar tokens; column types don't change (still Prisma
`String`/`String?`), they just hold `v1.<iv>.<ct>.<tag>` envelopes instead of plaintext.

**Blind index** (new primitive) for the two lookup columns:
`emailBlindIndex`/`phoneBlindIndex` = `HMAC-SHA-256(key, "${tenantId}\0${normalizedValue}")`,
base64url-encoded. Deterministic (same input → same output, so `WHERE emailBlindIndex = ?`
keeps working exactly like today's `WHERE normalizedEmail = ?`), not reversible, and
**tenant-scoped by mixing `tenantId` into the HMAC input** — without that, the same
customer emailing two different tenants would produce the same digest in both tenants'
rows, reintroducing a cross-tenant correlation channel in obfuscated form that a stolen
backup could exploit. With tenant scoping, a stolen backup can no longer tell "this
tenant has a customer with email X" (today's plaintext `normalizedEmail` discloses that
directly) or correlate a customer across tenants — the two properties this migration is
actually meant to buy. It is *not* protection against an attacker who also holds the
key (low-entropy inputs like email addresses remain dictionary-attackable with the key
in hand) — worth being explicit about that limit rather than overclaiming.

Two separate keys, standard blind-index hygiene (compromising one must not help attack
the other):
- `CUSTOMER_PII_ENCRYPTION_KEY` — seals/opens the display fields.
- `CUSTOMER_PII_BLIND_INDEX_KEY` — computes the HMAC digests.

Both 64 hex chars / 32 bytes, generated with `openssl rand -hex 32` (same shape and
generation instructions as `GOOGLE_TOKEN_ENCRYPTION_KEY`), both **required** —
`z.string().regex(/^[0-9a-fA-F]{64}$/u, ...)` with no `.optional()`, parsed once via
`parseEncryptionKey` at boot in the composition root (`apps/api/src/app.ts`,
`apps/worker/src/worker.ts`), injected as `Buffer` constructor args — never read from
`process.env` below that point (rule 3).

## The one required refactor: `customerMatches`

`packages/booking-engine/src/snapshots.ts`'s `customerMatches(existing, incoming)`
currently normalizes the *raw* incoming email/phone internally and compares the result
directly against `existing.normalizedEmail`/`normalizedPhone` (plaintext today). Once
those become blind-index tokens, this comparison has to happen on tokens, not raw
strings — and `@bam/booking-engine` must stay free of `node:crypto` (it's the pure,
zero-runtime-dependency engine package; encryption is an application-layer concern).

Fix: change `customerMatches`'s signature to accept **pre-computed tokens on both
sides** (`existing: { emailToken, phoneToken }`, `incoming: { emailToken, phoneToken }`)
and do plain string equality — it doesn't need to know whether a token is a lowercased
email or an HMAC digest. `normalizeEmail`/`normalizePhone` stay in `booking-engine`
unchanged (pure string transforms); the "normalize, then blind-index" step moves to
`booking.service.ts`, which already holds the blind-index key via constructor
injection. This is the highest-risk single diff in the plan — a bug here (e.g.
blind-indexing the unnormalized string) breaks customer matching silently, producing
duplicate `Customer` rows instead of a data-protection incident, so give it its own
test pass before touching the schema.

## Implementation order

**1. Primitives** — `packages/crypto/src/blind-index.ts` (new file, sibling to
`token-cipher.ts`; separate file because blind-indexing is a distinct primitive from
sealing, not a variant of it): `export function blindIndex(value: string, key: Buffer): string`,
doc-commented with the required `${tenantId}\0${normalizedValue}` input shape spelled
out explicitly (don't leave callers to discover the tenant-scoping convention). Re-export
from `packages/crypto/src/index.ts`. Tests in a new `blind-index.test.ts`: determinism
(same input+key → same output), different key → different output, output is not
reversible/does not contain the input.

**2. Config** — `packages/config/src/schema.ts`: add `CUSTOMER_PII_ENCRYPTION_KEY` and
`CUSTOMER_PII_BLIND_INDEX_KEY`, both required, same regex/message style as
`GOOGLE_TOKEN_ENCRYPTION_KEY`. Add both to the repo-root `.env.example` with the
`openssl rand -hex 32` generation note, and to whatever fixture currently supplies a
complete valid env for tests (the pattern `integrations.test.ts` already uses for
`GOOGLE_TOKEN_ENCRYPTION_KEY` — grep for that constant to find the shared test-env
setup and add the two new keys there too).

**3. `customerMatches` refactor** — `packages/booking-engine/src/snapshots.ts` +
`snapshots.test.ts`, per the section above. Land and green this before step 4.

**4. Schema migration** — `packages/db/prisma/schema.prisma`: rename
`Customer.normalizedEmail` → `emailBlindIndex` (`@map("email_blind_index")`),
`normalizedPhone` → `phoneBlindIndex` (`@map("phone_blind_index")`), same
`@@index([tenantId, ...])` shape, no type change. Run `prisma migrate dev` (never
`db push`, rule 1) and hand-verify the generated SQL uses `RENAME COLUMN` rather than
drop+recreate when the CLI prompts about the rename.

**5. Composition roots** — `apps/api/src/app.ts`, `apps/worker/src/worker.ts`: parse
both new keys via `parseEncryptionKey` at boot (same call shape as the currently
commented-out Google line), inject into `BookingService` and every worker module in
step 7.

**6. Write path** — `apps/api/src/modules/bookings/booking.service.ts`:
- `upsertCustomer`: normalize incoming email/phone (existing normalizers), blind-index
  them, look up candidates by `emailBlindIndex`/`phoneBlindIndex` equality, call the
  refactored `customerMatches` with tokens. On create/update, `sealToken` the
  `fullName`/`email`/`phone` values being written; store the blind-index tokens.
- Wherever `buildBookingSnapshot`'s (from `@bam/booking-engine`, unchanged/still
  plaintext-returning) result is persisted in `confirmBooking`/`createDirectBooking`:
  `sealToken` the three snapshot fields immediately before the `Booking` create call.
  Sealing happens at this persistence boundary, in the API service — not inside the
  pure engine.

**7. Read/decrypt path** — open with `CUSTOMER_PII_ENCRYPTION_KEY` at each confirmed
site:
- `apps/api/src/modules/bookings/booking.routes.ts` — staff booking list/detail
  response serialization.
- `apps/api/src/modules/availability/schedule-conflicts.service.ts`
  (`loadFutureBookings`) — the `SCHEDULE_CONFLICTS_BOOKINGS` payload.
- `apps/worker/src/outbox/outbox.dispatcher.ts` (`loadBookingFacts`).
- `apps/worker/src/notifications/notification.sender.ts` (`buildBookingEmail`).
- `apps/worker/src/calendar/calendar.processor.ts` — parked feature, but fix while
  touching this pattern so it isn't a forgotten gap when it's un-parked later.

**8. Backfill script** — new `packages/db/scripts/backfill-customer-pii.ts`, mirroring
the shape of `packages/db/scripts/join-tenant.ts`/`discard-organization.ts`
(`loadEnv()`, batched/paginated, `--dry-run` flag, summary output). Since this is
pre-launch data, a single pass is enough: for every `Customer` row, compute
`emailBlindIndex`/`phoneBlindIndex` from the existing normalized values and seal
`fullName`/`email`/`phone`; for every `Booking` row, seal the three snapshot columns.
Use the already-exported `looksSealed()` to skip any row already sealed, so the script
is safely re-runnable.

**9. Defense in depth** — `packages/observability/src/redaction.ts`: add `fullName`,
`email`, `phone`, `customerNameSnapshot`, `customerEmailSnapshot`,
`customerPhoneSnapshot` to `REDACT_PATHS`, mirroring the existing
`sealedAccessToken`/`sealedRefreshToken` entries. This matters regardless of encryption
correctness — decrypted values pass through application memory and must never end up
in a log line.

**10. Documentation** — add a new rule to `CLAUDE.md`'s rules list (style-matched to
rules 13–16) stating the invariant: customer PII is sealed at rest via `@bam/crypto`,
`emailBlindIndex`/`phoneBlindIndex` are one-way HMAC digests never decrypted or
displayed, both keys are required at boot.

## Verification

- `pnpm test` for `@bam/crypto` and `@bam/booking-engine` — new blind-index tests, the
  refactored `customerMatches` tests.
- `apps/api` integration tests: a booking created twice with the same email (across two
  requests) resolves to the same `Customer` row (blind-index equality still matches);
  the staff Bookings list returns plaintext names/emails in its JSON response; the
  notification path builds an email with the correct plaintext customer name.
- Direct DB inspection after running the backfill and creating one fresh booking
  through the public flow: query the `customers`/`bookings` tables and confirm
  `full_name`/`email`/`phone`/`customer_name_snapshot`/etc. are `v1.___.___.___`-shaped
  strings, and `email_blind_index`/`phone_blind_index` are opaque base64url strings —
  none of it human-readable.
- `pnpm db:drift-check` — confirms the migration matches the schema exactly (rule 1's
  CI gate).
- Spot-check `pnpm db:explain-availability` output still contains no raw customer PII
  (it shouldn't touch `Customer` at all, but worth confirming given it's the one script
  that runs against production without a safety refusal).

## Open item noted but out of scope here

Research for this plan surfaced that `CLAUDE.md`'s claim "Nothing in either [Phase 7 or
8] is in the codebase now" is inaccurate — `apps/api/src/modules/public/conversation.*`
exists, is registered in `app.ts`, and collects customer PII via `pickCustomer` into the
same `upsertCustomer` path this plan touches. That's a documentation-accuracy question
independent of PII encryption (the encryption design already covers this intake path,
since it shares the one choke point), but worth reconciling with `CLAUDE.md` separately.
