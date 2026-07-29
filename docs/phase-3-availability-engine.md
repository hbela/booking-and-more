This is the execution record for the fourth delivery phase, derived from PRD.md §9.5 and technical-implementation.md §44 (Epic 3).

# Phase 3 — Availability Engine

## Implementation Record

**Document version:** 1.0
**Scope:** Epic 3 — working-hours model, availability exceptions, the pure calculation package, slot generation, timezone support, unit and property tests, provider availability dashboard
**Depends on:** [phase-2-providers-services-locations.md](phase-2-providers-services-locations.md)
**Exit criteria:** Slots correctly reflect schedules, breaks, buffers and exceptions · Daylight-saving tests pass · Slot calculations are deterministic

---

# 1. Context

Phase 2 delivered a catalogue: who does the work, what it is, where it happens. None of it said _when_.

This phase adds the schedule and the arithmetic over it. It is the last piece before a booking can exist —
Epic 4 does not create appointments so much as claim slots this engine produced — and it is the part of the
system most likely to be quietly wrong, because the failure mode is not an error but a door locked at the hour
a customer was told to arrive.

---

# 2. The central decision: the engine is a function

`packages/availability-engine` has **no runtime dependencies**. Not few — none. It imports no Fastify, no
Prisma, no Redis, no HTTP client, and no date library (technical-implementation.md §13, CLAUDE.md rule 8).

That constraint buys one thing, and it is the thing that matters: the fifteen cases §13.5 requires can be
written as calls to a function. Two of them are daylight-saving transitions, and a DST test that needs a
database and a running clock is a test nobody writes twice.

## 2.1 Why no date library either

The engine needs exactly two operations: "what UTC instant is 09:00 local on this date in this zone", and its
inverse. Both are derivable from `Intl.DateTimeFormat`, which carries the platform's own IANA database — the
same source a library would consult.

`src/zone.ts` is 340 lines including its own tests' worth of commentary, and it is exhaustively tested,
including a property test that round-trips 500 random instants across seven zones. Adding a dependency to
avoid writing it would have been defensible; writing it keeps the package's central claim — that it depends on
nothing — literally true.

## 2.2 Daylight saving is explicit, not implied

Twice a year a wall-clock reading is either impossible or repeated, and `resolveWallClock` reports which:

| Case                  | Behaviour                                                                |
| --------------------- | ------------------------------------------------------------------------ |
| Ordinary              | `exact`                                                                  |
| Clocks sprang over it | `skipped` — snaps forward to the first instant that exists               |
| Clocks fell back      | `ambiguous` — takes the _earlier_ of the two instants that read the same |

Taking the earlier instant is what stops a working day silently starting an hour late. The gap search walks
forward a minute at a time rather than assuming an hour, which is why Lord Howe Island's 30-minute transition
resolves correctly instead of merely plausibly — and there is a test for exactly that.

The consequence is visible in the product: on the morning the clocks go back, a clinic open 01:00–05:00 is
open for five hours and **offers 02:00 twice**, an hour apart in real time. That is correct, and the booking
page will need to disambiguate them for customers (see §5).

## 2.3 `now` is an input

Not in §13.1's interface, and required. "Slot calculations are deterministic" is an exit criterion, and a
function that reads the system clock cannot satisfy it. Passing the clock in is what makes a daylight-saving
test reproducible rather than a thing that fails twice a year on CI.

---

# 3. Delivered

## 3.1 `packages/availability-engine`

| File           | Contents                                                                       |
| -------------- | ------------------------------------------------------------------------------ |
| `zone.ts`      | Wall-clock ↔ instant in an IANA zone; calendar-date arithmetic                 |
| `intervals.ts` | Half-open `[start, end)` algebra: normalize, subtract, clamp, contains         |
| `types.ts`     | `AvailabilityQuery`, `AvailableSlot`, `TimePeriod`, `DateTimePeriod` (§13.1–2) |
| `engine.ts`    | `generateSlots` — the eleven steps of §13.3                                    |

Half-open intervals are the decision everything else falls out of: an appointment ending at 10:00 and one
starting at 10:00 do not overlap, which is what "back-to-back" means to the person keeping the diary. With
closed intervals every adjacency becomes a one-millisecond argument.

### Two behaviours that are judgement calls

**Buffers must fit inside available time.** A slot is offered only when its whole occupied window —
before-buffer, appointment, after-buffer — sits inside free time. A clinic opening at 09:00 with a ten-minute
before-buffer therefore first offers 09:10, not 09:00: the preparation cannot happen before the provider has
arrived. The alternative reading, where buffers apply only _between_ appointments, books people into time
nobody is there for.

**The slot grid is anchored to the working period, not to the gaps.** Start times step from the opening time,
so they stay at 09:00, 09:15, 09:30 as bookings come and go. Anchoring to each free gap instead would make the
offered times shuffle every time someone else booked, which reads as a bug to anyone refreshing the page.

## 3.2 Database

Migrations `20260729051732_availability_working_hours_and_exceptions` and
`20260729051900_availability_check_constraints`.

**`working_hours`** stores local `HH:mm` strings, never timestamps. "Mondays 09:00–17:00" must stay
09:00–17:00 on the Monday the clocks change, and a stored UTC offset is right for half the year and an hour
wrong for the other half. Several rows per weekday is the normal case, not an edge case — a lunch break is a
gap between two periods rather than an attribute of one.

**`availability_exceptions`** stores `timestamptz`, because it names actual moments. The asymmetry is the
model: one table holds rules, the other holds events.

The second migration is hand-written, for the constraints Prisma cannot express — `HH:mm` format, weekday
range, a validity window that does not end before it begins, and an exception that ends after it starts. All
of them guard the engine's inputs, and all of them fail somewhere useless if left to fail later: a malformed
time does not break where it is written, it breaks in the middle of a slot calculation as an empty result
nobody can explain.

## 3.3 API

```http
GET    /v1/providers/:providerId/working-hours
PUT    /v1/providers/:providerId/working-hours              replace the whole week
GET    /v1/providers/:providerId/availability-exceptions
POST   /v1/providers/:providerId/availability-exceptions
PATCH  /v1/availability-exceptions/:exceptionId
DELETE /v1/availability-exceptions/:exceptionId
POST   /v1/slots/search                                     staff search
POST   /v1/public/tenants/:tenantSlug/slots/search          public search
```

`AvailabilityService` does the loading and the policy — which provider, whose hours, which of the several
notice windows wins — and the engine does the arithmetic. Nothing in the service computes a slot and nothing
in the engine touches a database.

### Where the `:own` permissions finally do something

Epic 1 wrote `canBlockProviderTime` and tested it failing closed, because `Membership.providerId` was always
null. Epic 2 populated it. This module is the first that actually asks.

The route guard cannot express the rule alone, because the answer depends on _which_ provider is in the URL.
So the guard establishes tenant membership, and the handler asks the pure policy function about the specific
resource. An administrator holds `availability:manage:all` and may edit anyone's diary; a provider holds
`availability:manage:own` and may edit only the diary their membership names; a provider whose membership
names nothing is refused, because an unpopulated field must never act as a wildcard.

### One search, two audiences

The public and staff searches call the same method with a `publicOnly` flag rather than having two
implementations that can drift. The flag applies exactly the filters the Epic 2 catalogue applies, so a
provider hidden from the booking page cannot be reached by searching for their slots directly — while the
front desk can still book them over the phone.

### Inheritance of the booking window

`minimumNoticeMinutes` and `maximumAdvanceDays` are nullable on both Provider and Service, where NULL means
inherit. The **most restrictive** value wins: a provider needing a day's warning and a service needing two
hours means a day, because the stricter is the one that would be violated. When nothing sets them, the
defaults are 0 minutes' notice and 180 days' horizon.

`slotIntervalMinutes` is a server constant at 15. §13.1 takes it as an input precisely so it can vary; making
it a tenant setting is a small change and is not asked for yet.

## 3.4 Web

`/dashboard/availability` (technical-implementation.md §28), in Hungarian and English. The week is edited as a
grid where each day holds a list of periods — starting from "a list per day" rather than "one row per day with
an optional break" is what makes a lunch break expressible without a special case.

An administrator picks any provider; a provider linked to a diary sees only their own and no picker. That
mirrors the API, and is still only an affordance — the server re-decides on every request.

## 3.5 Seed

`pnpm db:seed` now gives Anna weekday hours with a lunch break and Béla two afternoons. Without working hours
the catalogue is fully configured and nothing is bookable, which makes a fresh clone look broken.

---

# 4. Safeguards worth naming

| Risk                                                 | Safeguard                                                  | Test                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Schedule an hour wrong for half the year             | Wall-clock storage; both ends resolved through the zone    | "keeps the working day at its wall-clock times when the clocks spring forward" |
| A slot offered at an hour that does not exist        | `resolveWallClock` reports `skipped`                       | "loses the hour that does not exist on a spring-forward morning"               |
| A working day starting an hour late on fall-back day | Ambiguous readings take the earlier instant                | "takes the earlier instant when a reading happens twice"                       |
| Non-flagship zones handled by assumption             | Gap search walks forward rather than assuming an hour      | "handles a half-hour transition"                                               |
| Non-deterministic results                            | `now` is an input; no clock inside the engine              | property: "is deterministic"                                                   |
| An off-by-one in interval subtraction                | Monotonicity property                                      | property: "never gains slots when time is taken away"                          |
| Buffers ignored at the edge of the working day       | Whole occupied window must fit in free time                | "reports the occupied span including buffers"                                  |
| A provider editing someone else's diary              | `canBlockProviderTime` on the resource, not just the route | "refuses a provider editing somebody else's diary"                             |
| An unlinked provider membership acting as a wildcard | Ownership checked separately from the permission           | "refuses a provider whose membership is not linked to anything"                |
| Cross-tenant schedule read or write                  | `tenantId` in every repository `where`                     | "refuses to touch another tenant's provider"                                   |
| An unpublished provider reachable via slot search    | `publicOnly` applies the catalogue's own filters           | "hides a provider whose online booking is switched off…"                       |
| A malformed time reaching the engine                 | CHECK constraints plus Zod                                 | "rejects a malformed or empty period"                                          |
| An unbounded search                                  | 62-day cap on the requested range                          | "refuses a range longer than two months"                                       |

---

# 5. Deviations and known gaps

1. **`now` added to `AvailabilityQuery`**, which §13.1 does not list. Required for determinism — see §2.3.
2. **Bookings, holds and external busy periods are always empty.** The engine subtracts all three and is
   tested doing so; there is simply nothing yet to subtract. Epic 4 supplies bookings and holds, Epic 6 the
   calendar.
3. **The repeated 02:00 is not disambiguated for customers.** On a fall-back morning the public search
   returns two slots reading 02:00. Both are real and an hour apart. Presenting them distinguishably is a
   booking-page problem and belongs with Epic 6.
4. **`slotIntervalMinutes` is a constant**, not a tenant setting — see §3.3.
5. **Exceptions are hard-deleted**, unlike the catalogue. An exception is a statement about time that has not
   happened yet: nothing points at it and it explains no history, which is exactly why the archive rule does
   not apply.
6. **`datetime-local` in the dashboard uses the browser's zone**, not the provider's. Right for staff sitting
   at the clinic, wrong for an administrator in another country. The fix is a zone picker, and it belongs with
   the calendar view rather than a form.
7. **No calendar view.** The availability screen is a form, not a week grid. Epic 6 brings the visual
   calendar.

---

# 6. Verification

```bash
pnpm lint && pnpm check-types && pnpm test   # 15/15 tasks, 261 tests
pnpm build
pnpm db:drift-check
pnpm db:seed                                 # twice, to prove idempotence
```

## 6.1 Results — 2026-07-29

| Suite                                                 | Result                                  |
| ----------------------------------------------------- | --------------------------------------- |
| `@bam/availability-engine` (units + properties)       | 74 passed                               |
| `@bam/api` (health, tenancy, catalogue, availability) | 126 passed                              |
| `@bam/auth` policy units                              | 28 passed                               |
| `@bam/config`                                         | 14 passed                               |
| `@bam/contracts`                                      | 9 passed                                |
| `@bam/observability`                                  | 5 passed                                |
| `@bam/db`                                             | 5 passed                                |
| **Total**                                             | **261 passed**, 15/15 turbo tasks green |

The engine's 74 split into 22 zone tests, 36 slot-generation cases covering all fifteen §13.5 scenarios, and
16 property tests run at 100–300 cases each. The API's 29 new integration tests cover what the engine cannot
see: that the right rows are loaded, the right tenant owns them, and a provider can edit their own diary and
nobody else's.

## 6.2 Live, against the seeded clinic

1. `pnpm db:seed`, then a public slot search for Monday and Tuesday: 44 slots for the 45-minute cleaning, 67
   for the 20-minute consultation. ✓
2. The consultation returns two providers, the cleaning one — matching who is assigned to what. ✓
3. Monday's cleaning starts run 09:00 … 11:00, then resume at 13:00: the lunch break appears as a gap without
   anything modelling a "break". ✓
4. The last morning start is 11:00, not 11:15 — a 45-minute appointment plus its 10-minute after-buffer must
   finish by 12:00. ✓

---

# 7. Next

Epic 4 — the booking engine: holds, capacity reservations, the PostgreSQL exclusion constraint
(technical-implementation.md §11.2), the confirmation transaction and the transactional outbox. It consumes
this engine directly: a hold claims a slot this phase produced, and the `bookings` and `activeHolds` inputs
that are empty today start carrying rows.
