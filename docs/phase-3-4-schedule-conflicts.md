This is the plan for closing a gap found on 2026-08-16 by asking a question no phase record had an
answer to: _a provider with bookings changes their working hours — can that conflict with the
bookings?_ It can, and nothing anywhere says so.

# Phases 3–4 — Schedule/booking conflicts

## Implementation Record

**Document version:** 1.0 — planned and built 2026-08-16. Done bar §6's manual walk.
**Scope:** a save that would strand existing bookings outside the schedule is refused once, with the
list of what it would strand, and succeeds when re-sent acknowledged (option 1); and a booking already
stranded — however it got that way — is marked as such wherever bookings are listed (option 2).
**Depends on:** [phase-3-availability-engine.md](phase-3-availability-engine.md) (the engine and the
wall-clock rule) · [phase-4-booking-engine.md](phase-4-booking-engine.md) §5 (the slot search is what
validates a booking's instant) · [phase-2-3-owner-management.md](phase-2-3-owner-management.md) §2
(the whole-set `PUT` rule this rides on) and §2.6 (availability belongs to the provider — which is why
this warns rather than refuses).

---

# 1. The gap

`working_hours` and `bookings` are independent tables with no constraint between them, and nothing in
the application supplies one.

`setWorkingHours` ([availability.service.ts:93](../apps/api/src/modules/availability/availability.service.ts#L93))
validates exactly three things: the provider exists, the named locations exist, and no period is zero
minutes long. It never reads `bookings` or `capacity_reservations`. `replaceWorkingHours`
([availability.repository.ts:95](../apps/api/src/modules/availability/availability.repository.ts#L95))
then deletes the whole set and recreates it. `createException` has the same shape and the same
silence.

## 1.1 What is already safe, and must stay that way

The dangerous version of this cannot happen, and the reasons are worth stating so the fix does not
accidentally undo one:

- **No booking is deleted, altered or hidden.** There is no foreign key from a booking to a working
  hours row, so removing Tuesday leaves every Tuesday booking intact — visible in the diary, with its
  confirmation sent, its manage link working, and its reminder still due. `checkStillOwed` keys on
  booking *status*, never on the schedule.
- **Nobody can be double-booked into the stranded time.** `capacity_reservations` is the single
  authority for "is this time taken" (rule 14) and is independent of the schedule. The stranded
  booking still holds its slot against the exclusion constraint.
- **No new booking lands in removed hours**, because searches read the new schedule immediately.
- **A reschedule cannot make it worse**: both the customer and staff paths go through
  `assertSlotIsOffered`, so a booking can only move *into* the current schedule.

## 1.2 What actually goes wrong

The provider has an appointment at a time their own schedule says they do not work, and **nobody is
told** — not the provider saving the change, not the owner, not the customer. The save succeeds
silently and the two facts disagree until a human notices, most likely the customer, on the day.

Time off is the likelier path than a working-hours edit. "I am away next week" is a far commoner
action than "I no longer work Tuesdays", and `createException` has exactly the same silence.

---

# 2. Decisions

## 2.1 The question is asked once, as a pure function in the engine

`findUncoveredAppointments` goes in `packages/availability-engine`, beside `generateSlots` and built
from the same `normalize` / `subtract` / `contains` primitives.

This is the load-bearing choice. Both features and both call sites ask the same question — "is this
appointment inside available time?" — and the slot search already answers a version of it. A second
implementation would eventually disagree with `generateSlots`, and the failure mode of disagreement
here is a warning that fires on a booking the search would happily have made, which teaches an owner
to click through the dialog. One function, no runtime dependencies, property-testable (rule 8).

It takes a provider's resolved schedule and a list of appointments and returns the ones not covered,
each with a reason — `OUTSIDE_WORKING_HOURS` or `BLOCKED_BY_EXCEPTION`. The reason is not decoration:
"outside your hours" and "during your time off" are different sentences for the reader, and the second
one is usually intentional.

## 2.2 It judges the appointment, not the occupied span

The slot search requires the *whole* occupied window — before-buffer, appointment, after-buffer —
inside free time, and is right to: it decides whether a booking may be made, and preparation cannot
happen before the provider has arrived (phase-3, `generateSlots`).

This check deliberately uses the appointment span alone. The question it answers is "will the provider
be there for the appointment?", not "does the cleanup fit". Including buffers would fire on a 16:50
appointment whose ten-minute after-buffer runs past a 17:00 close — a warning about nothing, on a
booking that was legitimately made, and the fastest way to train somebody to dismiss the dialog
without reading it.

Excluding buffers can only ever produce *fewer* warnings, never a missed one: a buffer cannot make the
appointment itself uncovered. So this is an asymmetry with `assertSlotIsOffered` and not a
disagreement with it. Recorded here because it looks like an oversight and is not.

## 2.3 Only future bookings, and only live ones

`PENDING` and `CONFIRMED`, starting after now. `CANCELLED`, `EXPIRED`, `COMPLETED` and `NO_SHOW` are
void or historical, and a past booking cannot be fixed by anybody — warning about one makes every save
noisy forever and the badge permanent. The field means "somebody should look at this", which a
finished appointment does not deserve.

## 2.4 The save is refused once, not blocked

`PUT …/working-hours` returns **409 `SCHEDULE_CONFLICTS_BOOKINGS`** with the affected bookings in
`details`. The same request re-sent with `acknowledgeAffectedBookings: true` in the body succeeds.

Structural rather than remembered: the destructive save cannot happen without the list having been
returned to the client first, and the check re-runs on the acknowledged call, so a booking made in
between is caught too.

**Not a preview endpoint.** `GET …/working-hours/conflicts?…` reads nicer, but it has a
time-of-check/time-of-use window, costs a second round trip, and — the deciding objection — a client
that forgets to call it gets no protection at all. A 409 cannot be forgotten.

**Not a hard refusal.** Phase-2-3 §2.6 puts availability in the provider's hands, and a clinic that
genuinely needs to change its hours would otherwise be stuck with one escape hatch: cancelling real
customers' appointments. The tool must not force that. The owner keeps the decision; what changes is
that they make it knowingly.

## 2.5 The same gate on exceptions, for `UNAVAILABLE` only

`POST` and `PATCH` on availability exceptions take the same acknowledgement, for `UNAVAILABLE`
exceptions. `ADDITIONAL_AVAILABILITY` only ever adds time and can strand nothing.

This is the half that will fire most. It is in scope precisely because shipping the working-hours
guard alone would leave the commoner path silent and look like the problem was solved.

## 2.6 The badge reads the same function, computed per page

`GET /v1/bookings` gains a computed `outsideSchedule` field on each row — the reason, or null.

Computed for the returned page in one pass rather than per row: group the page's bookings by provider,
load each distinct provider's working hours and exceptions once, run the engine once per provider.
Cost is bounded by the page size and the number of distinct providers on it, which for a day's diary
is small.

It is derived, never stored. A stored flag would be wrong the moment the schedule changed again, and
keeping it true would mean writing to every affected booking on every schedule save — a write
amplification with a staleness bug attached, replacing a cheap read.

## 2.7 A booking is judged against the schedule it was made under

The slot search resolves a booking's zone as `location.timezone ?? provider.timezone` and scopes
working hours to `locationId` — a row naming another site does not apply, a row naming none applies
everywhere ([`planFor`](../apps/api/src/modules/availability/availability.service.ts#L400)).

Both call sites here must resolve it identically or the badge will contradict the search that made the
booking — worst on exactly the tenant this matters for, a chain with a branch in another zone. The
resolution is therefore lifted into one helper both paths call, rather than written twice.

The tenant's `defaultTimezone` is the final fallback, as it is for booking emails.

---

# 3. Delivered

## 3.1 `packages/availability-engine`

`findUncoveredAppointments` in `engine.ts`, beside `generateSlots` and reusing its private `appliesOn`
and `periodToInterval` — which is why it is in that file rather than a new one. `UncoveredReasons`,
`CoverageQuery`, `ScheduledAppointment` and `UncoveredAppointment` exported alongside.

It throws on an unparseable span rather than reporting it uncovered, matching `assertQueryIsSane`
next door: the quiet alternative is a clinic cancelling a real appointment over a caller bug.

`coverage.test.ts` — 16 cases, including the spring-forward Sunday, a night shift whose 00:30
appointment falls on the following calendar day, and one pair of instants judged against the same
written hours in two zones.

## 3.2 `packages/contracts`

`SCHEDULE_CONFLICTS_BOOKINGS` in `ErrorCodes`, and `schedule-conflicts.ts` carrying
`uncoveredReasonSchema`, `affectedBookingSchema` and `outsideScheduleSchema`.

The reason enum is **restated** rather than imported from the engine, because this package has no
dependency on that one and is not growing one for two string literals. The restating is made safe by
`schedule-conflicts.contract.test.ts` in `apps/api` — the package that depends on both — in the same
arrangement as `notification-engine.contract.test.ts` in `@bam/db`.

`affectedBookingSchema` deliberately carries no customer contact details. The dialog answers "how
many, and when"; a list of phone numbers on a screen about working hours is more personal data than
the decision needs (rule 6).

## 3.3 API

| File | Change |
| --- | --- |
| `schedule-conflicts.service.ts` | new — both halves of this record, one class |
| `availability.service.ts` | the guard on `setWorkingHours`, `createException`, `updateException`; `assertNothingStranded` |
| `availability.schemas.ts` | `acknowledgeAffectedBookings` on the three bodies |
| `availability.routes.ts` | passes the flag and `now` |
| `booking.schemas.ts` | `outsideSchedule` on the booking response |
| `booking.routes.ts` | one `annotate` call per page; `toBookingResponse` takes the reason |

`updateException` merges `type`, `locationId` and `serviceId` against the stored row the same way it
already merged the times — a PATCH moving only the end must still be judged with the scope the row
already has. It also passes `replacesExceptionId`, without which shrinking a closure *off* a booking
would be refused for the booking it is being shrunk off.

`acknowledgeAffectedBookings` is stripped explicitly before the update rather than left to
`definedOnly`, which drops `undefined` and would happily try to write `false` to a column that does
not exist.

## 3.4 Web

`lib/affected-bookings.ts` narrows the refusal back into a list, and filters entries it cannot render
rather than casting — this is the screen somebody reaches when something is already wrong, and
`undefined — undefined` in the dialog would be worse than a shorter list.

`components/affected-bookings-dialog.tsx` is a native `<dialog>` driven by `showModal()`, which brings
the focus trap, Escape, the inert background and `aria-modal` with it. Both editors render it; both
send the first attempt unacknowledged, always, so the refusal is what carries the list.

`ApiError` gained `details` — untyped on purpose, since its shape varies by code.

The badge is `warning`, never `danger`: nothing is broken and nobody has lost an appointment. It
carries its own word rather than relying on the tint (WCAG 1.4.1), with the specific reason in the
`title`. Eight keys per locale, in `hu` and `en`.

---

# 4. Verification

| Failure                                                        | Prevented by                                              | Test                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| Hours removed under a confirmed booking, silently              | 409 on the unacknowledged save                            | "refuses a save that would leave a booking outside…"        |
| A 409 that had already written the hours                        | the check runs before `replaceWorkingHours`               | "changes nothing when it refuses"                            |
| An owner unable to make a change they mean to                   | the acknowledgement                                       | "lets the same change through once it is acknowledged"       |
| A dialog on every save, which nobody reads                      | §2.2, §2.3                                                | "says nothing about a change that strands nobody"            |
| Time off booked over an appointment, silently                   | the same gate on `UNAVAILABLE`                            | "refuses time off booked over an appointment…"               |
| An extra opening interrogated for no reason                     | `ADDITIONAL_AVAILABILITY` adds time and strands nothing   | "lets an extra opening through without asking"               |
| A closure counted against itself while being shrunk             | `replacesExceptionId`                                     | "does not count a closure against itself…"                   |
| Stranding a booking by unticking a box                          | inactive rows are excluded, as the search excludes them   | "treats switching a period off the same as deleting it"      |
| Every save noisy because of last year's appointments            | §2.3 — future and live only                               | "ignores a booking already in the past", "…cancelled"        |
| A stale flag surviving a schedule changed back                  | §2.6 — derived, never stored                              | "marks one on the list, and clears it when the hours…"       |
| Cross-tenant read while gathering affected bookings             | `tenantId` in every read (rule 5)                         | "refuses to read another tenant's diary while answering"     |
| The two reason enums drifting apart silently                    | one assertion over both                                   | `schedule-conflicts.contract.test.ts`                        |
| A dialog opening on an unrelated error                          | the code is checked, not just the status                  | `affected-bookings.test.ts`                                  |

Twelve integration tests in `availability.test.ts`, 16 engine unit tests, five client-narrowing tests,
one contract test. `pnpm lint && pnpm check-types && pnpm test && pnpm build` all pass.

A save that acknowledges, and a booking made between the two requests, is covered by construction
rather than by a test: the acknowledged call runs the same check and simply does not refuse. The
window it closes is that the *list* can be stale, not that the write is unguarded.

---

# 5. Known limits

1. **Nothing is emailed.** A stranded booking's customer is not told, because there is nothing true to
   tell them yet — the appointment still stands. Cancelling or moving it is the clinic's decision, and
   both of those already send mail.
2. **The badge is on the staff list only.** A provider's own diary view shows it; the customer's
   manage-booking screen deliberately does not. To the customer nothing has changed.
3. **No sweep.** Bookings stranded before this shipped are found by reading the list, not by a job.
   The badge is computed on read, so they surface the first time anybody looks.
4. **The badge is not on the customer's booking calendar either**, and the public slot search is
   untouched: a stranded booking still holds its reservation, so it still removes its time from sale.
   That is correct and worth stating, because "the schedule does not cover it" and "the slot is free"
   are different questions and only the second one is the search's.
5. **`annotate` runs one pair of queries per distinct provider on the page**, sequentially. For a
   day's diary that is a handful. A month's export filtered to every provider would be worse, and the
   fix when it matters is one grouped query rather than a cache.

---

# 6. Still to walk by hand

Not done. In the dashboard, against a real browser:

1. Make a booking, then remove the hours under it. The dialog lists it, names the customer and the
   time, and says nobody is emailed.
2. Escape and the Go back button both close it, and the schedule is unchanged afterwards.
3. Save anyway. The hours land, and the Bookings screen shows **Outside schedule** on that row.
4. Put the hours back. The badge clears with no write to the booking.
5. Book time off over an appointment. The same dialog, with "During time off" as the reason.
6. Both of the above in Hungarian, and in dark mode — the dialog is the one new surface with its own
   backdrop, and `backdrop:bg-black/40` is the only place a colour is not a token.
