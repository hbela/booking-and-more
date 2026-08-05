This is the execution record for the fifth delivery phase, derived from PRD.md §9.8–9.9 and technical-implementation.md §44 (Epic 4).

# Phase 4 — Booking Engine

## Implementation Record

**Document version:** 1.0
**Scope:** Epic 4 — booking holds, capacity reservations, the PostgreSQL exclusion constraint, booking
confirmation, rescheduling, cancellation, management tokens, idempotency, public booking forms
**Depends on:** [phase-3-availability-engine.md](phase-3-availability-engine.md)
**Exit criteria:** A customer can complete a booking · Two concurrent users cannot confirm the same exclusive
slot · Holds expire automatically · Rescheduling is transactional

---

# 1. Context

Phase 3 could answer "when is this provider free". It could not take an appointment, and the two are not the
same problem. Availability is arithmetic over data nobody is competing for; a booking is a claim on a
resource two people want at once, and the entire difficulty is what happens in the moment they both want it.

Delivered in three commits: the engine and the schema, the API, then the web.

---

# 2. The central decision: the database decides who wins

Nothing in TypeScript makes Epic 4's second exit criterion true. It is true because of one exclusion
constraint (technical-implementation.md §11.3):

```sql
ALTER TABLE capacity_reservations
  ADD CONSTRAINT capacity_reservations_no_overlap
  EXCLUDE USING gist (provider_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&)
  WHERE (status = 'ACTIVE');
```

A `SELECT` before an `INSERT` loses this race by construction: between the check and the write there is a
window, and under load somebody is always inside it. PostgreSQL is the only participant that can decide, so
it does — and the application's job is to translate its refusal into `SLOT_NO_LONGER_AVAILABLE` rather than
to attempt the decision itself.

That one constraint covers four failures at once: two customers confirming the same slot, a customer
confirming over another's live hold, two holds on one slot (PRD §9.8), and staff booking over a customer
mid-checkout.

## 2.1 What the packages do and do not do

CLAUDE.md rule 8 names the booking engine as pure alongside the availability engine, and §14 sketches an
interface whose methods return Promises. Both cannot be true: acquiring capacity _is_ the database.

The split follows the one Epic 3 drew. `packages/booking-engine` decides — whether a hold is usable, whether
a status may change, whether a booking is inside its window, how wide a diary block an appointment carves
out, what a booking records about the world. `apps/api` loads, transacts and persists. What is genuinely a
race is decided by neither: it is decided by the `INSERT` failing.

## 2.2 Expiry is arithmetic, not an event

There is no scheduler until Epic 5. So `expires_at` is the truth and `status` is a cache of it: every read
goes through `effectiveHoldStatus`, which reports what a row means now rather than what it was last written
as.

That leaves one genuine problem, and it is asserted in a test rather than glossed over. An exclusion
constraint's predicate cannot call `now()`, so an expired-but-unswept reservation goes on blocking its slot.
The API therefore sweeps expired reservations **inside the transaction that claims the next slot** — the one
moment the answer is guaranteed to matter. Epic 5's worker can add a periodic sweep; it will be an
optimisation, not a correctness fix.

The slot search treats expired reservations as free, so a customer is offered the slot and the sweep in their
own transaction makes the offer good.

---

# 3. Delivered

## 3.1 `packages/booking-engine`

| File             | Contents                                                                    |
| ---------------- | --------------------------------------------------------------------------- |
| `spans.ts`       | `occupiedSpanFor` — the only definition of a diary block; half-open overlap |
| `holds.ts`       | Expiry arithmetic, the three ways a hold becomes unusable, the countdown    |
| `transitions.ts` | The booking state machine, and which statuses free capacity                 |
| `policy.ts`      | Booking window, cancellation and reschedule rules, inheritance              |
| `snapshots.ts`   | What a booking records; customer matching on normalised contact details     |

`occupiedSpanFor` is load-bearing. Three things must agree about a booked slot — the availability engine's
`occupiedFrom`/`occupiedUntil`, the reservation row written for it, and the busy period fed into the next
search — and they agree because all three come from this one function. A property test asserts the first
against the third directly; a second books the middle slot of a generated day and checks that _exactly_ the
colliding slots vanish, none more and none fewer.

Every check returns a `Decision` rather than throwing. The engine has no opinion about HTTP status codes, and
a caller branching on _why_ something was refused should not have to catch and re-inspect an error.

### Terminal means terminal

`CANCELLED`, `COMPLETED`, `NO_SHOW` and `EXPIRED` lead nowhere — staff cannot un-cancel. Cancelling releases
the reservation, so the slot is back on sale the instant the transaction commits; by the time somebody wants
the booking back the time may belong to another customer, and a state machine cannot promise otherwise.
Reinstatement is a new booking. `booking-for-all` allowed `CANCELLED → CONFIRMED` and produced two confirmed
bookings in one slot, neither wrong according to the code that made them.

## 3.2 Database

Migrations `20260729061038_booking_holds_reservations_and_bookings` and
`20260729061500_booking_exclusion_and_check_constraints`.

Six tables: `customers`, `capacity_reservations`, `booking_holds`, `bookings`, `outbox_events`,
`idempotency_keys`. A slot being taken is recorded in up to three rows and the separation is deliberate —
reservations are the gate, holds are the customer's five minutes, bookings are the appointment.

**Appointment versus occupied.** Holds and bookings store what the customer was told; reservations store what
the diary loses, buffers included. Two appointments that do not overlap can still have overlapping buffers,
and that is a real conflict.

**Snapshots.** Bookings copy the customer name, service name and price rather than joining for them. Rule 11
keeps catalogue rows alive so the foreign keys never dangle, which solves referential integrity and nothing
else: a service renamed and repriced next year would otherwise have a booking claim the customer agreed to a
price they never saw.

The second migration also keeps §11.2's constraint on `bookings` itself, deliberately weaker — it compares
appointment times, not occupied windows. It guards what the gate cannot see: a booking written without a
reservation by an import or a data fix. A backstop that also encoded buffer policy would need DDL every time
a service's buffers changed.

Plus the CHECKs that stop a row being _unreachable_ rather than merely wrong: an ACTIVE reservation with no
owner (nothing will ever release it), a hold-owned one with no expiry (immortal, invisible to the sweep), a
price without a currency, a cancelled booking that does not say when.

## 3.3 API

```http
POST   /v1/public/tenants/:tenantSlug/holds            DELETE .../holds/:holdId
POST   /v1/public/tenants/:tenantSlug/bookings
GET    /v1/public/bookings/:managementToken
POST   /v1/public/bookings/:managementToken/reschedule/{prepare,confirm}
POST   /v1/public/bookings/:managementToken/cancel/{prepare,confirm}
GET    /v1/bookings          POST /v1/bookings
GET    /v1/bookings/:id      PATCH /v1/bookings/:id
POST   /v1/bookings/:id/{reschedule,cancel}/{prepare,confirm}
```

**Where the booking window is enforced.** At hold creation, not at confirmation. A hold _is_ the customer's
claim on the slot; re-testing the notice period four minutes later would let a hold made legitimately at
08:58 be refused at 09:01 for a rule it satisfied when it was made.

**Whether the schedule offers a time** is answered by asking the slot search — the same question the
customer's browser asked — rather than reimplementing §11.4's steps 3–5. Two engines computing availability
two ways is how a booking page and a booking engine end up disagreeing about a Tuesday.

**Rescheduling** moves the existing reservation row with one `UPDATE`, re-checked by the constraint.
Release-then-reacquire has a gap in the middle. A collision rolls back with the booking exactly where it was.
The booking's own reservation is excluded from the search that validates its new time, or moving a 60-minute
appointment half an hour later would be impossible.

**Staff bookings** skip the notice and advance windows. Those govern strangers; a receptionist fitting
somebody in this afternoon is the business exercising its own judgement, and refusing it only teaches people
to work around the system. Working hours, the past, and the exclusion constraint still apply.

**Audit and outbox rows are written inside the transaction**, not through `request.audit()`. That plugin
documents itself as fire-and-forget, which is right for a settings change and wrong here.

**Idempotency (§32)** claims the key _before_ the work runs, so a second request arriving mid-flight is told
the first is still going. The claim is not part of the operation's transaction: if the work rolls back the
claim survives without a response and the retry gets `IDEMPOTENCY_KEY_IN_PROGRESS`. That is the safe
direction to be wrong in — a stuck key expires, a duplicated booking does not.

**Management tokens** are 32 random bytes stored only as a SHA-256 hash (§34.4).
`findByManagementToken` is the one repository method without a `tenantId`, and the exception is deliberate:
the token _selects_ the tenant rather than being scoped by one. Rule 5 exists to stop a tenant being inferred
from ambient state; here it is derived from a secret the caller had to possess.

### Phase 3's gap is closed

`searchSlots` passed `bookings: []` and `activeHolds: []` and said so in a comment. It now reads
`capacity_reservations` — the same table the constraint enforces, so the search cannot disagree with the
answer the database will give.

## 3.4 Web

`/[tenantSlug]/book` and `/booking/manage/[token]`, plus `/dashboard/bookings`, in Hungarian and English.

§28 lists `/book/service`, `/book/provider`, `/book/time` as separate routes. They are one route with a step
state instead: a hold is live from the moment a time is picked, and a real navigation between steps risks
losing it — a customer tapping back would leave a five-minute reservation behind with nothing able to release
it. Keeping the flow in one component gives the hold an owner for its whole life, and a `pagehide` handler
releases it on the way out.

The countdown is derived from `expiresAt` rather than counted down from a number, so a backgrounded tab —
where browsers throttle timers hard — shows the truth when it returns.

The staff screen is a list, not a calendar grid; Epic 6 brings the calendar, and building half of one here
would mean throwing it away.

## 3.5 Seed

One confirmed booking next Monday, idempotent by reference — re-running the seed would otherwise collide with
the exclusion constraint, correctly and confusingly.

---

# 4. Safeguards worth naming

| Risk                                                 | Safeguard                                                  | Test                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Two customers confirm one appointment                | Exclusion constraint over `capacity_reservations`          | "gives the slot to exactly one of two simultaneous holds"          |
| Staff book over a customer mid-checkout              | A hold takes a real reservation, not an advisory flag      | "stops staff booking over a customer who is mid-checkout"          |
| A held slot still offered to the next visitor        | The search reads the reservation table                     | "removes a held slot from the next search…"                        |
| An abandoned checkout costs the slot forever         | Sweep inside the claiming transaction                      | "refuses to confirm a hold that has run out, and frees the slot"   |
| A retried confirmation books twice                   | Idempotency key claimed before the work                    | "replays the first response instead of booking twice"              |
| A key reused for a different action                  | Request body hashed with a key-order-stable serialiser     | "refuses a key reused for a different request"                     |
| A reschedule loses the original slot on collision    | The reservation is moved, not released and re-acquired     | "leaves the booking where it was when the new time is taken"       |
| An appointment cannot be moved half an hour later    | Its own reservation excluded from the validating search    | "moves to an overlapping later time without colliding with itself" |
| A cancelled slot never returns to sale               | Cancellation releases the reservation in the transaction   | "puts the slot back on sale"                                       |
| A management link reaching the wrong booking         | 32 random bytes, unique index on the hash, one 404 for all | "reaches exactly one booking and reveals nothing else"             |
| A database leak handing over working links           | Only the SHA-256 hash is stored                            | "stores only a hash…"                                              |
| Cross-tenant read or cancellation                    | `tenantId` in every repository `where`                     | "refuses to read or change another tenant's booking"               |
| A provider seeing the whole tenant's diary           | List narrowed by `booking:read:own`                        | "shows a provider only their own bookings"                         |
| An unlinked provider membership acting as a wildcard | Refused outright rather than defaulting to no filter       | "refuses a provider whose membership is not linked to a diary"     |
| A booking nobody can be contacted about              | Public form requires an email or a phone number            | "refuses a public booking with no way to reach the customer"       |
| A booking outside working hours                      | The slot search validates the requested instant            | "refuses a slot the schedule does not offer"                       |
| Completing a booking silently freeing its slot       | Only CANCELLED and EXPIRED release capacity                | "marks a booking completed without freeing its slot"               |
| A booking losing the record of its own creation      | Audit and outbox rows written in the same transaction      | "writes the audit row and the outbox event with the booking"       |

---

# 5. Deviations and known gaps

1. **`cancellationNoticeMinutes` is a parameter, not a column.** `Tenant.cancellationPolicy` is free text and
   nothing in the data model states a number of minutes, so rather than invent a column no spec asks for, the
   rule is expressible in the engine and the API passes `null`. What always applies is the rule needing no
   configuration: an appointment that has started cannot be cancelled, only marked `NO_SHOW`. Adding the
   column later does not change the function.
2. **Nothing is emailed.** The outbox accumulates `BOOKING_CONFIRMED`, `BOOKING_REQUESTED`,
   `BOOKING_RESCHEDULED` and `BOOKING_CANCELLED` rows and no worker reads them until Epic 5. The success
   screen says so rather than implying a confirmation is on its way.

   **Closed on 2026-08-05** by [phase-5-booking-notifications.md](phase-5-booking-notifications.md). Two
   things there change assumptions made here. The management token now travels in the outbox payload for
   the length of one dispatch, because §3.3's "stored only as a hash" left the worker unable to build a
   link to the manage page — read its §2.1 before adding a link to any other email. And the reminder
   deliberately carries no link, which is §4's "a database leak handing over working links" safeguard
   winning an argument it would otherwise have lost by months (§2.2). The success screen's wording needs
   revisiting: a confirmation genuinely is on its way now.

3. **`PENDING` bookings never expire on their own.** The status exists and the transition to `EXPIRED` is
   legal, but nothing runs to make it. Epic 5's worker is the natural owner.
4. **The booking flow is one route, not six** — see §3.4. Deep links per step wait for Epic 6.
5. **No calendar view**, staff or customer. The staff screen is a filtered list.
6. **`datetime-local` in the reschedule form uses the browser's zone**, not the clinic's. The same gap Epic 3
   recorded for the availability screen, and the same fix: a zone picker, with the calendar view.
7. **External busy periods are still empty.** The engine subtracts them and there is nothing to subtract until
   Google Calendar lands in Epic 6.
8. **`bookings.customer_id` is `ON DELETE RESTRICT` under a tenant cascade.** Deleting a tenant may trip over
   it depending on the order PostgreSQL picks. Not a problem for the application — tenants are `CLOSED`,
   never deleted — but `prisma migrate reset` and any future tenant-deletion path will need to care. Tests
   clean up in explicit order.

---

# 6. Verification

```bash
pnpm lint && pnpm check-types && pnpm test   # 17/17 tasks, 391 tests
pnpm build
pnpm db:drift-check
pnpm db:seed                                 # twice, to prove idempotence
```

## 6.1 Results — 2026-07-29

| Suite                                                           | Result                                  |
| --------------------------------------------------------------- | --------------------------------------- |
| `@bam/booking-engine` (units + properties)                      | 89 passed                               |
| `@bam/availability-engine`                                      | 74 passed                               |
| `@bam/api` (health, tenancy, catalogue, availability, bookings) | 153 passed                              |
| `@bam/auth` policy units                                        | 28 passed                               |
| `@bam/db` (connection, extensions, booking constraints)         | 19 passed                               |
| `@bam/config`                                                   | 14 passed                               |
| `@bam/contracts`                                                | 9 passed                                |
| `@bam/observability`                                            | 5 passed                                |
| **Total**                                                       | **391 passed**, 17/17 turbo tasks green |

261 → 391 across the epic: 89 in the new engine, 14 new database-constraint tests, 27 new API integration
tests.

## 6.2 Bugs found during the phase

1. **`lockHold` returned an object that type-checked and was nothing of the sort.** It used
   `SELECT * FOR UPDATE` typed as `BookingHold`, but `$queryRaw` bypasses `schema.prisma`'s column mapping,
   so it returned `expires_at` rather than `expiresAt`. Every confirmation 500'd. It now locks by id and
   re-reads through Prisma.
2. **A CHECK constraint caught a test.** Backdating a hold's `expires_at` to simulate expiry violated
   `booking_holds_expiry_after_creation`; the test now moves `created_at` too. The constraint working as
   intended.

---

# 7. Next

> **Done — 2026-08-05**, in three parts: [phase-5 — notifications](phase-5-notifications.md) (queues, the
> outbox poller, the dispatcher), Epic 9 (the email provider, built early because onboarding needed it first),
> and [phase-5 — booking notifications](phase-5-booking-notifications.md) (the five booking templates and the
> sweep). The paragraph below is what was predicted here; it is kept rather than replaced because the
> difference is worth recording.

Epic 5 — notifications: BullMQ, Redis, the outbox worker, and the email provider. It is the first thing that
genuinely needs Redis, which is why it was deferred from Epic 0. The rows it will consume are already being
written.

**All four pieces exist.** What the list misses is the design, because it names the transport and not the
shape. Three things carry the weight and none of them are in that sentence:

- **the `notifications` row** — a second durable record between the outbox and the queue. That row is the
  commitment; the BullMQ job is only a prompt to act on it;
- **the dedupe key**, and the unique index on `(tenant_id, dedupe_key)` that makes at-least-once delivery
  safe without a single `SELECT`-before-`INSERT`;
- **the sweep**, which did not exist as a concept when this was written and is the only reason a reminder
  more than 15 minutes out ever fires.

**And the Redis claim is backwards.** Epic 5 did not turn out to need Redis in the sense meant here. The
design deliberately keeps nothing durable in it: lose the instance and every notification row is still
`PENDING`, and the next sweep re-enqueues it. What needed Redis was punctuality to the second — and the sweep
degrades even that to a minute rather than to a lost message. It is safe to run on a Redis with no
persistence at all, which was not the expectation when this line was written.

**What Epic 5 did not deliver**, and what is therefore still open:

- **Distributed rate limiting.** [app.ts](../apps/api/src/app.ts) still carries the comment "Epic 5 swaps in
  Redis so limits hold across instances". It did not. Limits remain per-instance, which makes them
  decorative the moment there are two API processes — the one item here that is a regression against a
  written intention rather than an unbuilt feature.
- **Dead-lettering is a ceiling, not a queue.** A `FAILED` row preserves the evidence and surfaces it
  nowhere.
- **`SMS` and `PUSH`** are in the channel enum and in `NotificationChannels`; neither has a provider.
- **Nothing notifies staff.** All seven templates write to a customer or an owner; a booking arriving is
  visible only in the diary. `CALENDAR_DISCONNECTED` is the one type in the schema with no renderer, and it
  is the same neighbourhood.
- **Six of the seven queues have no consumer**, but only three of those are gaps: `calendar-sync`,
  `usage-aggregation` and `retention-cleanup` await their epics. `hold-expiration` is empty _by design_ — a
  hold expires by arithmetic and is swept inside the transaction that needs its slot
  ([holds.ts](../packages/booking-engine/src/holds.ts)) — and `booking-reminders` lost its job to the sweep.
- **No test covers the whole chain.** The API asserts what the outbox carries, the dispatcher what the
  notification row holds, the sender what renders from it; nothing runs all three against one booking. That
  is why phase-5-booking-notifications §5.2's manual walk is load-bearing, **and it has not been walked.**

Next after that is Epic 6 — calendar synchronisation, which is what `calendar-sync` and
`CALENDAR_DISCONNECTED` are waiting for.
