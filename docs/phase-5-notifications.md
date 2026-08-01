This is the execution record for the sixth delivery phase, derived from PRD.md §12.5 and
technical-implementation.md §12, §26, §27 (Epic 5).

# Phase 5 — Notifications

## Implementation Record

**Document version:** 1.0 (part 1 of 3)
**Scope:** Epic 5 — outbox dispatch, Redis and BullMQ, the notification record, the pure notification engine.
Email delivery and templates are part 2; reminders, the sweep and dead-lettering are part 3.
**Depends on:** [phase-4-booking-engine.md](phase-4-booking-engine.md)
**Exit criteria (epic):** Booking emails are sent asynchronously · Failed email jobs retry safely · Duplicate
events do not send duplicate messages

---

# 1. Context

Epic 4 left `outbox_events` rows accumulating with nothing to drain them, which was the correct behaviour
rather than a gap: the rows are the record that someone is owed a message, and nothing about them expires.
This phase builds the drain.

Docker arrived on the development machine on 2026-07-29, part-way through planning this epic, which changed
one decision — local Redis now comes from `docker/docker-compose.yml` rather than a hosted instance — and
left the rest intact. The Testcontainers deviation from
[phase 0 §4.1](phase-0-technical-foundation.md) is now unblocked but deliberately not taken in this phase;
switching test infrastructure in the middle of an epic buys nothing and risks confusing a real failure with
a harness change.

---

# 2. The central decision: three links, and only the last one is disposable

```text
outbox_events   →   notifications   →   BullMQ job
(the API owes       (the platform       (something should
 someone this)       owes this           act on it now)
                     message)
```

The first two links are durable rows in PostgreSQL. The third is not, and that is the point rather than a
compromise. A notification row is the commitment; the queue job is only a prompt to act on it. If Redis
loses every job it holds, nothing is forgotten — the rows are still `PENDING` with a `scheduled_at` in the
past, and the sweep in part 3 picks them up.

That is what makes it defensible to run this against a Redis instance with no persistence, and it is the
same reasoning as the outbox itself one level down: the queue is an optimisation over a database that
already knows the answer.

## 2.1 Exactly-once, where it can actually be enforced

The queue offers at-least-once delivery, and no arrangement of retries upgrades that to exactly-once. What
does is a unique index:

```sql
CREATE UNIQUE INDEX notifications_tenant_id_dedupe_key_key
  ON notifications (tenant_id, dedupe_key);
```

The second insert loses, and the loser has nothing to send. Application code translates `P2002` into
"already handled" and does not `SELECT` first — between the select and the insert is exactly the window that
manufactures duplicates. This is CLAUDE.md rule 14 applied to a second resource, as that rule asks.

Three distinct sources of duplication collapse through it, and they are genuinely different:

1. the dispatcher claims a row, publishes, and dies before marking it processed;
2. BullMQ retries a job whose failure happened after the send;
3. two API requests write two outbox events for one action.

What must _not_ collapse is a booking rescheduled twice, or a reminder for an appointment that moved. Those
share a booking id and are different messages, so the key carries a discriminator per type — the booking's
optimistic-locking `version` for an update, the appointment start for a reminder. A naive key of
`(type, bookingId)` silently swallows the second reschedule email, and
`packages/notification-engine/src/dedupe.test.ts` asserts it does not.

## 2.2 The claim is one statement

```sql
UPDATE outbox_events AS e
SET status = 'PROCESSING', claimed_at = now(), attempts = e.attempts + 1
FROM (
  SELECT id FROM outbox_events
  WHERE (status = 'PENDING' AND available_at <= now())
     OR (status = 'PROCESSING' AND claimed_at < now() - make_interval(secs => $1))
  ORDER BY available_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $2
) AS claimed
WHERE e.id = claimed.id
RETURNING …
```

Raw SQL because Prisma cannot express row-level locking, and the two-statement version it _can_ express —
read the pending rows, then mark them — has a window in which a second worker reads the same rows. Same
shape of mistake as checking capacity before inserting a reservation, same fix.

Two details worth keeping:

- **`attempts` increments at claim time, not at failure time.** A worker killed mid-dispatch would otherwise
  be reclaimed with its count unchanged and retry forever. Counting the claim means even a crash loop
  terminates at the ceiling and parks the row for a human.
- **`claimed_at` is new in this phase.** Without it nothing distinguishes "being worked on right now" from
  "claimed by a process that no longer exists".

---

# 3. Delivered

## 3.1 `packages/notification-engine`

A fourth package with no runtime dependencies, following the seam Epics 3 and 4 established: decisions about
values live in a pure package, I/O lives in the app.

| Module        | Decides                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `planning.ts` | which messages an outbox event owes, to whom, and when                      |
| `dedupe.ts`   | the identity that makes a message send exactly once                         |
| `locale.ts`   | which language it goes out in — customer's preference over the tenant's     |
| `retry.ts`    | whether a failure is transient or permanent (§26.3), and the backoff to use |

75 tests. The engine restates the notification enums as string literals rather than importing them from
Prisma; `packages/db/src/notification-engine.contract.test.ts` asserts the two stay in step, so drift is a
failing test rather than a runtime surprise.

Two judgement calls recorded because they are the kind that get "simplified" later:

- **An unrecognised failure is treated as transient.** Wrongly calling one permanent silently loses a
  confirmation a customer is waiting for; wrongly calling one transient costs a handful of attempts before
  the ceiling parks it. The asymmetry is not close.
- **Backoff uses full jitter.** Every job in a batch fails at the same moment when a provider goes down, and
  undithered backoff marches them all back in lockstep exactly as the provider is recovering.

## 3.2 Database

`notifications` (tech-impl §27) — one row per message owed, written before anything is sent, and both the
delivery-tracking record and the deduplication key.

`NotificationStatus` carries `SKIPPED` distinct from `FAILED`. A booking taken over the phone with no email
address has nothing to send to, and that is a correct outcome; collapsing it into `FAILED` would fill a
dead-letter queue with bookings that are fine.

Migrations: `20260729115648_notifications_delivery_tracking`, `20260729122559_outbox_claimed_at`.

## 3.3 `apps/worker`

- `redis.ts` — one lazily-constructed, deliberately shared connection. BullMQ opens its own per Queue and two
  per Worker unless handed one; seven queues reaches twenty-odd connections without anyone deciding to, and
  hosted Redis plans cap connections well before memory. `maxRetriesPerRequest: null` is required by BullMQ
  and is why the connection is built here rather than from a URL at each call site.
- `queues.ts` — all seven queues from §26, and job retention defaults. Without `removeOnComplete` /
  `removeOnFail` limits, completed jobs accumulate forever, which under `noeviction` is not untidiness but
  an outage: a full keyspace turns into write errors.
- `outbox/` — the repository (claim, settle), the dispatcher (plan, persist, enqueue), and the poller.

Polling rather than `LISTEN`/`NOTIFY`: a NOTIFY reaches whoever is connected at that moment and nobody
afterwards, so a worker that is restarting when the booking commits never learns of it. The outbox is a
catch-up mechanism and should behave like one.

Notifications scheduled more than 15 minutes out are left as rows rather than handed to BullMQ as delayed
jobs. Delayed jobs occupy a Redis sorted set for the whole delay, so a reminder three weeks ahead costs three
weeks of memory per booking and buys nothing the row does not already provide.

## 3.4 Configuration

`RESEND_API_KEY` and `EMAIL_FROM` are optional but paired, refined together the way the Google OAuth keys
already were — an API key with no sender address fails only once a job reaches Resend, asynchronously, one
retry at a time. Added alongside: `BOOKING_REMINDER_LEAD_HOURS`, `OUTBOX_POLL_INTERVAL_MS`,
`OUTBOX_BATCH_SIZE`, `OUTBOX_MAX_ATTEMPTS`.

`recipient` was added to the redaction paths in `@bam/observability`. It is an email address and it travels
through the dispatcher and the sender on every job; notification rows are identified in logs by id for
exactly this reason (rule 6).

---

# 4. The bug this phase found: every `timestamptz` was written wrong

Worth its own section, because it predates this epic and was invisible to every test in the repository.

`node-postgres` serialises a JS `Date` as its UTC digits with no offset, and PostgreSQL then reads that
literal in the session's `TimeZone`. On a machine set to Europe/Budapest, the instant `10:00:00Z` was stored
as `2026-07-29 10:00:00+02` — the instant `08:00:00Z`, two hours early. Reads applied the same offset in
reverse, so a Prisma round-trip returned exactly what it stored and every test that wrote and read through
Prisma passed.

What did not survive was any comparison PostgreSQL performed itself. `available_at <= now()` in the new
claim query was wrong by the local UTC offset, which is how it surfaced: a test asserting that a
future-dated event is not claimed failed, and failed in isolation.

The fix is one line in `createPrismaClient` — `options: "-c timezone=UTC"` on the adapter — so the digits the
driver sends mean what they say.

Two things make this worse than a fixed two-hour skew, and both argue for the regression test in
`packages/db/src/timezone.test.ts` asserting through `extract(epoch …)` rather than through Dates:

- the offset changes with daylight saving, so the same code is two hours out in July and one in January,
  with nothing in the application changing in between;
- it pairs with rule 13. A recurring schedule is wall-clock and lives in `working_hours` as local `HH:mm`;
  everything stored as `timestamptz` is an instant, and an instant has exactly one correct reading.

**Data written before this fix is shifted by the local offset.** No production data exists, but the
development and test databases should be re-seeded rather than trusted.

---

# 5. Deviations and known gaps

1. **Nothing sends yet.** The `notifications` queue has no consumer until part 2. Running the worker now
   drains outbox rows and leaves `PENDING` notification rows in their place, which is the observable result
   and is deliberately verifiable without an email provider.
2. **Reminders are planned but not delivered.** `planNotifications` schedules them and the rows are written;
   the sweep that picks up anything past the 15-minute queue horizon arrives in part 3, so a reminder more
   than 15 minutes out currently sits as a row and nothing acts on it.
3. **Testcontainers still not adopted** — see §1.
4. **`docker/docker-compose.yml`'s redis service uses `expose`, not `ports`.** Reachable inside the compose
   network only, so it is not usable from apps running natively on the host until a `6379:6379` mapping is
   added.
5. **Dead-letter handling (§26.3) is a ceiling, not a queue.** Exhausted outbox rows are parked as `FAILED`
   with `last_error` and never deleted, which preserves the evidence but does not surface it anywhere.

---

# 6. Verification

```bash
pnpm lint && pnpm check-types    # clean
pnpm build
pnpm db:drift-check              # no drift
```

## 6.1 Results — 2026-07-29

| Suite                                                        | Result              |
| ------------------------------------------------------------ | ------------------- |
| `@bam/api`                                                   | 153 passed          |
| `@bam/booking-engine`                                        | 89 passed           |
| `@bam/notification-engine` (planning, dedupe, locale, retry) | 75 passed (new)     |
| `@bam/availability-engine`                                   | 74 passed           |
| `@bam/db` (+ contract, + timezone)                           | 29 passed (19 → 29) |
| `@bam/config`                                                | 14 passed           |
| `@bam/worker` (dispatcher integration)                       | 14 passed (new)     |
| `@bam/contracts`                                             | 9 passed            |
| **Total**                                                    | **457 passed**      |

391 → 457: 75 in the new engine, 14 dispatcher integration tests, 5 enum-contract tests, 5 timezone
regression tests.

The dispatcher's tests are integration tests against a real PostgreSQL on purpose. Everything interesting in
them is a property of the database — `FOR UPDATE SKIP LOCKED` refusing to hand one row to two workers, the
unique index refusing a duplicate — and a mocked Prisma would assert only that the code calls the methods it
calls.

## 6.2 End-to-end, against a real Redis

Tests alone would not have caught the two bugs below, so the worker was run against
`redis:8-alpine` in Docker with the dev database:

| Before                | After                            |
| --------------------- | -------------------------------- |
| 3 outbox rows PENDING | 3 PROCESSED                      |
| 0 notification rows   | 1 written                        |
| empty Redis           | job in `bull:notifications:wait` |

The eviction check was then pointed at a second container running `--maxmemory-policy allkeys-lru`, which
logged the expected error. BullMQ emits its own warning for the same condition, which is worth noting: the
concern is the library's, not an invented one.

## 6.3 Bugs found during the phase

1. **`timestamptz` written with the wrong instant.** See §4. Pre-existing, repository-wide, found by a new
   test.
2. **The eviction-policy check never ran.** It was issued immediately after constructing the connection, and
   `enableOfflineQueue: false` rejects any command sent before the socket is up. The `catch` reported
   "eviction policy check unavailable" every single time — a check that always fails is worse than no check,
   because it reports "unavailable" rather than "not run". Fixed by awaiting readiness first. Found by
   running the process, not by a test.
3. **A CHECK constraint caught a test.** Setting a booking to `CANCELLED` without `cancelled_at` violates
   `bookings_cancelled_at_present`. The constraint working as intended.

---

# 7. Next

Part 2 — the email provider behind a provider-neutral interface (§27), localized `hu`/`en` templates, and the
`notifications` queue consumer that turns a `PENDING` row into a sent message and records the provider's
message id.
