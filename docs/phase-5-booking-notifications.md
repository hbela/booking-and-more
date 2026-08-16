This is the execution record for the part of Epic 5 the booking epic was waiting on: the templates and
the sweep that turn [phase-4-booking-engine.md](phase-4-booking-engine.md)'s accumulated outbox rows
into email a customer actually receives.

# Phase 5 — Booking notifications

## Implementation Record

**Document version:** 1.0 — built 2026-08-05.
**Scope:** the five booking emails (requested, confirmed, rescheduled, cancelled, reminder), the
management link that travels with the first of them, the send-time re-check that stops a message
about a booking that has moved on, and the sweep that makes a reminder fire at all.
**Depends on:** [phase-4-booking-engine.md](phase-4-booking-engine.md) §3.3 (the management token is
stored only as a hash) and §5.2 (the gap this closes) ·
[phase-5-notifications.md](phase-5-notifications.md) §5.1 and §5.2 (the two gaps this closes) ·
[phase-9-owner-onboarding-emails.md](phase-9-owner-onboarding-emails.md) §2 (an `EmailProvider` that
does not deliver must not report success) ·
[phase-9-owner-language-and-return-paths.md](phase-9-owner-language-and-return-paths.md) §2
(`buildAppUrl` is the only way to build a link to one of our own screens).

---

# 1. Context

Phase 4 shipped a booking flow that works and says nothing. Its §5.2 recorded the reason honestly —
"the outbox accumulates `BOOKING_CONFIRMED`, `BOOKING_REQUESTED`, `BOOKING_RESCHEDULED` and
`BOOKING_CANCELLED` rows and no worker reads them until Epic 5" — and the success screen told the
customer so rather than implying a confirmation was on its way.

Epic 9 then overtook Epic 5. It needed email before this phase's part 2 arrived, so it built the
consumer, the provider abstraction and six templates for onboarding and billing. The delivery chain
is therefore complete and proven; the booking side was the only consumer left unbuilt.

Three specific holes made that worse than "no email yet", and none of them were visible from the
phase-4 record:

1. **`BOOKING_REQUESTED` had no mapping.** A service with `requiresApproval` produces a `PENDING`
   booking and an outbox row `planNotifications` did not recognise, so it was marked processed and
   discarded. A customer whose booking needed accepting heard nothing at all.
2. **Staff acceptance wrote no outbox row.** `updateBooking` moved `PENDING → CONFIRMED` with an
   audit row and nothing else. Even once templates existed, the moment the customer most wants to
   hear about — "yes, we can see you" — emitted no event to hear about it with.
3. **Reminders could never fire.** Anything scheduled beyond the dispatcher's 15-minute queue horizon
   is "left for the sweep", and no sweep existed. A reminder row sat `PENDING` until long after the
   appointment had passed.

---

# 2. Decisions

## 2.1 The management link travels once, in the customer's first email

A booking's management token is 32 random bytes stored only as a SHA-256 hash (phase-4 §3.3). It
exists in plaintext for the length of one request — the response to `POST /bookings` — and then
nowhere. So a worker cannot rebuild a manage link from the database, and an email containing one has
only two options: carry the token, or not have the link.

It carries it, by exactly the route invitation tokens already take (phase-9 §2.5): into the outbox
row's payload, out again at dispatch, into `notifications.payload` as a finished URL, and cleared by
`markProcessed` and by the sender on a successful send. Exposure is bounded to the seconds between
commit and delivery, which is the same bound the onboarding emails have run under since Epic 9.

**Which emails get it is decided by which ones can.** `confirmBooking` and `createDirectBooking` hold
the raw token; nothing else does. A public reschedule is authenticated _by_ the token and could pass
it along, but a staff reschedule cannot — so making the link conditional on who moved the booking
would produce an email that sometimes has a button and sometimes does not, for a reason no recipient
could infer. Instead:

| Email                  | Manage link             | Why                                                                                                                        |
| ---------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `booking-requested`    | yes                     | the customer's first and only copy                                                                                         |
| `booking-confirmation` | when a token is present | present on a straight-through booking; absent when staff accept a request, and the copy points back at the requested email |
| `booking-updated`      | no                      | the link they already hold still works, and the copy says so                                                               |
| `booking-cancelled`    | no                      | there is nothing left to manage; it offers the public booking page instead                                                 |
| `booking-reminder`     | no                      | see §2.2                                                                                                                   |

## 2.2 The reminder carries no link, and that is the point

A reminder's row is written when the booking is made and sends `BOOKING_REMINDER_LEAD_HOURS` before
the appointment. The gap between those two moments is the booking horizon — days, and up to whatever
`maximumAdvanceDays` allows. A manage URL in `notifications.payload` would therefore leave working
credentials sitting in the database for that whole period, for every future booking at once.

That is precisely the exposure phase-4 §4 lists a safeguard against: "a database leak handing over
working links → only the SHA-256 hash is stored". Bounding the invitation-token window to seconds was
what made §2.1 acceptable; a reminder cannot have that bound, so it does not get the token.

The reminder names the appointment, the provider and the place, and tells the customer to use the
link in their confirmation email or to call. The trade is real — a one-tap cancel in the reminder is
the single most effective anti-no-show device there is — and it is recorded in §5 as the deviation to
revisit if a short-lived, reminder-specific token is ever built.

## 2.3 A booking email renders from the booking as it is now

`loadBookingFacts` in the dispatcher already re-reads the booking when a job runs rather than trusting
the event's payload, because "a confirmation event redelivered after a cancellation must not send a
confirmation". The sender needs the same discipline and for a stronger reason: a reminder is planned
at booking time and sent a day before the appointment, and a great deal can happen in between.

So the booking path in the sender loads the booking (scoped by `tenantId`, rule 5), formats from it,
and calls `checkStillOwed` first. A message the booking no longer owes is `SKIPPED` with the reason —
not `FAILED`, because retrying cannot make a cancelled booking live again, and the dead-letter queue
should keep meaning something (the same reasoning as a missing template).

`checkStillOwed` is a pure function in `@bam/notification-engine` rather than an `if` in the worker,
for the ordinary reason (rule 8) and one specific one: it and `planNotifications` must agree about
what "live" means, and they agree because both read the same `LIVE_BOOKING_STATUSES`.

## 2.4 `BOOKING_REQUESTED` is its own notification type

The tempting shortcut is to send the request-received email as a `BOOKING_CONFIRMATION` with a
different template. It is wrong, and the dedupe table is where it shows: `BOOKING_CONFIRMATION` is
keyed `{ bookingId }` — one per booking, forever — so the acceptance email that follows a request
would collide with the request email and be silently swallowed. The customer would be told their
booking was requested and never told it was accepted, which is the worst of the three possible
outcomes.

A distinct type costs one appended enum value and makes both keys correct. It also earns its keep in
the copy: "we have your request" and "you are booked" are different promises, and a template shared
between them would have to hedge both.

**A request plans no reminder.** `planNotifications` plans a confirmation and its reminder together,
because the moment a booking exists is the moment both are owed. A _request_ is not a booking yet —
reminding somebody about an appointment nobody has accepted is worse than silence — so the reminder
is planned by the `BOOKING_CONFIRMED` event that acceptance now writes. The reminder's dedupe key is
`{ bookingId, startAtIso }`, so a booking that goes straight through and one that is accepted later
both end up with exactly one.

## 2.5 The sweep is the catch-up path, not the fast path

The dispatcher hands BullMQ only what is due within 15 minutes; the rest is a row with a
`scheduled_at`. The sweep selects `PENDING` notifications due inside that same horizon and enqueues
them with `jobId: notificationId`.

It takes no claim and needs none. The sender already claims with a conditional `PENDING → SENDING`
update — PostgreSQL decides, the loser sees zero rows — and the job id makes a duplicate enqueue a
no-op before that. Two mechanisms, both already load-bearing, so the sweep can be the simplest thing
that could work.

It runs on its own interval (`NOTIFICATION_SWEEP_INTERVAL_MS`, default 60s) rather than the outbox's,
because it is the recovery path for two different failures — a reminder crossing the horizon, and a
Redis that lost every job in it — and neither is urgent to the second. The `@@index([status,
scheduledAt])` on `notifications` was added in Epic 5 part 1 for exactly this query.

## 2.6 The calendar link is a prefill URL, and only the confirmation carries it

_Added 2026-08-16, after the original build._

The confirmed email now offers "Add to Google Calendar" beside the manage button. It is a
`calendar.google.com/calendar/render?action=TEMPLATE&…` URL built by `buildGoogleCalendarUrl` in
`packages/notification-engine/src/calendar.ts` — a pure function of the booking's values, beside the
templates and for the same reason (rule 8).

**Why a link rather than an `.ics` attachment.** `.ics` is the interoperable answer and would serve
Apple Calendar and Outlook too, but it has to be attached, and `EmailProvider.send` carries a subject
and two bodies and nothing else. Widening that interface drags in the Resend adapter, the logging
provider and every test double — a larger change than the one asked for, buying nothing for the
customer it is aimed at. When Apple and Outlook are wanted, the honest move is `.ics` for everyone,
not three vendor links side by side.

**The timestamps are UTC, and that is not the inconsistency it looks like.** Everything the five
emails _print_ is formatted in the appointment's own zone, resolved location → provider → tenant
(tech-impl §13.4), because that is where the appointment happens. The URL sends the raw instants with
a trailing `Z`, because a calendar entry _is_ an instant and Google renders it in whichever zone the
customer's calendar is set to. A customer booking a Budapest clinic from Dublin therefore reads
"10:00" in the email and sees 09:00 on their own phone, and both are right. Same distinction as
phase-6 §2.7 — a printed time is read in a zone, an event is a moment. Two tests hold the pair in
place, one per side.

**It returns `null` rather than guessing.** An invalid or non-positive span produces no link. A saved
calendar entry outlives the email and will be trusted over it, so a confirmation missing one
convenience beats an entry at the wrong moment.

**Only `BOOKING_CONFIRMATION` offers it, and structurally so** — the value is a required field on
`BookingConfirmationValues` and on no other template's. The requested email is explicit that nothing
is booked yet; a cancellation and a reminder are not things to save. The reschedule email is the
arguable omission and was left out on purpose: a prefill URL cannot update an entry the customer
already saved, so it would add a _second_ entry to their calendar for the same appointment. Moving an
existing one is what Epic 6's actual Google Calendar sync is for; this is a link, not an integration,
and holds no token and reads no account.

It is independent of the manage link, so it is present on the staff-accepted path where §2.1 leaves
that one absent. Nothing about §2.1 changes: this URL is not a credential, which is why it may also
be built at any time from the booking rather than travelling in the payload.

---

# 3. Delivered

## 3.1 `packages/notification-engine`

| File           | Change                                                                                 |
| -------------- | -------------------------------------------------------------------------------------- |
| `types.ts`     | `BOOKING_REQUESTED` appended                                                           |
| `dedupe.ts`    | its variant, keyed `{ bookingId }` — one request email per booking                     |
| `planning.ts`  | `BOOKING_REQUESTED` mapped (no reminder), and `checkStillOwed` for the send-time check |
| `templates.ts` | five renderers in `hu` and `en`, plus the shared appointment block they all print      |
| `calendar.ts`  | §2.6, added 2026-08-16: `buildGoogleCalendarUrl` and its one localized label            |

`bookingEmail` assembles all five so they differ only where they mean to: greeting, one sentence, the
same six-fact details table, then whatever that message adds. `detailPairs` drops the place and price
lines rather than printing an empty label — a single-site clinic records neither, and "Where:" with
nothing after it reads as missing information.

The dedupe keys were already right for four of the five. The one change that mattered is §2.4's.

`bookingEmail` grew one optional `secondary` link in the same 2026-08-16 change — rendered as an
underlined text link rather than a second `BUTTON_STYLE`, because two equally weighted buttons make
the reader choose before reading, and the primary action is the one that changes the booking. It is
underlined as well as coloured: colour alone is not a link indicator (WCAG 1.4.1), and an email
client may override the colour but not the decoration.

## 3.2 Database

Migration `20260805092252_notification_type_booking_requested` — one appended enum value, as
`ALTER TYPE … ADD VALUE`. `notification-engine.contract.test.ts` compares the two sides sorted, so it
needed no change and would have failed had only one side been updated.

## 3.3 API

`writeOutbox` takes an optional payload. Three callers use it:

| Event                                                              | Carries           | Because                                              |
| ------------------------------------------------------------------ | ----------------- | ---------------------------------------------------- |
| `BOOKING_CONFIRMED` (from `confirmBooking`, `createDirectBooking`) | `managementToken` | only the hash is stored                              |
| `BOOKING_REQUESTED`                                                | `managementToken` | same, and it is the customer's only copy             |
| `BOOKING_RESCHEDULED`                                              | `previousStartAt` | the booking has already moved by the time it is read |

And `updateBooking` now writes a `BOOKING_CONFIRMED` event when the transition is PENDING →
CONFIRMED, inside the same transaction as the audit row. Nothing else there does: COMPLETED and
NO_SHOW record what happened on the day, and a customer does not need an email saying they turned up.

## 3.4 Worker

`bookingPayloadFor` in the dispatcher decides which notification gets which of those three facts, and
is the single place §2.1's asymmetry is written down. `loadBookingFacts` also returns the tenant slug
now — it builds the cancellation email's "book another time" link, and is not a planning fact.

The sender splits in two. `build` routes booking types to `buildBookingEmail`, which re-reads the
booking — `endAt` included since 2026-08-16, solely to size §2.6's calendar event — calls
`checkStillOwed`, and formats — times through `Intl` in the location's zone falling
back to the provider's then the tenant's, money through the `formatMoney` that already asks `Intl` how
many minor digits a currency has. Everything else goes through the existing `render`, whose
fall-through now describes what is genuinely left: `CALENDAR_DISCONNECTED`, until Epic 6.

`notification.sweeper.ts` is new: the query, and a poller modelled on the outbox one. Wired into
`worker.ts` and stopped before the queues close.

## 3.5 Web

One line of copy, and it had to change: the success screen told the customer "confirmation emails are
not switched on yet", which phase-4 §5.2 was right to say and this phase makes false. It now says a
confirmation is coming and asks them to keep the link anyway — which is the honest instruction, given
§2.2 means the reminder will not repeat it. The message key was renamed with it; `noEmailYet` would
have been a trap for the next person to read the file.

`[locale]/[tenantSlug]/page.tsx` is new, and was found by walking §5.2 rather than by design.
`/{slug}` matched no page — only `/{slug}/book` did — so a clinic's own address 404'd. That is the
address people type and share; it is what goes on a poster. It now redirects to the booking form
through next-intl's locale-aware `redirect`, so `/en/wellness` reaches `/en/wellness/book` rather than
the Hungarian one.

It also removes a **hydration error**, though not by fixing its cause. Any 404 under a locale renders
the global `app/not-found.tsx`, which has to emit its own `<html lang="hu">` because nothing wraps it,
while the client hydrates against the `<html lang="en">` `[locale]/layout.tsx` produced for that URL.
React reports an unpatchable attribute mismatch on `<html>` — see §4.8.

---

# 4. Deviations and known gaps

1. **The reminder has no cancel link.** §2.2. The trade is real — a one-tap cancel in the reminder is
   the most effective anti-no-show device there is — and it is the deviation to revisit first. The fix
   is not "carry the token anyway": it is a second, short-lived token minted when the reminder is
   _sent_, which needs a column and a decision about its lifetime.
2. **Only the customer is emailed.** Nothing tells staff a booking arrived; the diary is the only
   place it shows up. `CALENDAR_DISCONNECTED` is still the one notification type in the schema with
   no renderer, and staff-facing notification is its neighbourhood.
3. **`BOOKING_REMINDER_LEAD_HOURS` is one number for the whole platform.** A dentist wanting 48 hours
   and a hairdresser wanting 2 get the same. Per-tenant configuration is a column and a form field,
   and nothing in the engine would change.
4. **Dead-lettering is still a ceiling, not a queue** — phase-5 §5.5, unchanged. An exhausted
   notification is `FAILED` with `last_error` and nothing surfaces it.
5. **The sweep re-enqueues rows already on the queue.** A row stays PENDING until the sender claims
   it, so a sweep firing while a job is queued but not yet running finds it again. Harmless — the job
   id collapses them and the claim decides — but it means `found` is not a backlog measurement.
6. **No test proves the whole chain.** The API tests assert what the outbox carries, the dispatcher
   tests what the notification row holds, and the sender tests what is rendered from it; nothing runs
   all three in sequence against one booking. §5's manual walk is where that is checked.
7. **The success screen's manage link is not locale-prefixed.** `booking-flow.tsx` builds it as a bare
   `<a href={`/booking/manage/…`}>`, so an English-speaking customer lands on the Hungarian page —
   the same bug
   [phase-9-owner-language-and-return-paths.md](phase-9-owner-language-and-return-paths.md) §2 fixed
   for every server-built URL. Pre-existing, found while changing the copy beside it, and left alone
   because the fix belongs with a pass over the client-side links rather than in this one. The
   _emailed_ link is correct: it goes through `buildAppUrl`, and a test asserts the prefix.
8. **Every 404 under a locale still throws a hydration error**, and §3.5 only moved one URL out of the
   way of it. The cause is two documents: the global `app/not-found.tsx` must render `<html>` because
   no root layout wraps it, and `[locale]/layout.tsx` renders another with a different `lang`.

   Three fixes were tried and none worked, which is worth recording so nobody repeats them. A
   locale-scoped `[locale]/not-found.tsx` does not help — Next sends _unmatched_ URLs to the global
   not-found, never a nested one, and nothing in the locale tree calls `notFound()` except the layout
   itself, whose throw cannot be caught beneath it. A `[locale]/[...rest]` catch-all does not help
   either: it compiles and registers, but loses to the sibling `[tenantSlug]` segment, so the request
   resolves to a matched segment with no page.

   The fix that would work is structural — a root `app/layout.tsx` owning `<html lang>` (read through
   next-intl's `getLocale()`), with `[locale]/layout.tsx` rendering neither `<html>` nor `<body>`.
   That is a layout refactor touching every route, and it did not belong in a phase about email.

9. **The staff diary's row actions are one click and irreversible**, and until the walk found it, the
   first of them was invisible. `ActionButton` composed `buttonClass` (`bg-brand-600 text-white`) with
   `bg-transparent text-slate-900` appended — which does not override anything, because Tailwind
   resolves conflicting utilities by stylesheet order, not attribute order. In the compiled CSS
   `text-white` follows `text-slate-900` while `bg-transparent` follows `bg-brand-600`, so the button
   rendered white-on-transparent: a faint border with an unreadable label, sitting directly under the
   booking it completes. A provider clicked it and moved a CONFIRMED booking to COMPLETED without
   knowing what they had pressed.

   Fixed by building the variant from `secondaryButtonClass`, which sets no conflicting property.
   **The one-click part is not fixed.** `COMPLETED`, `NO_SHOW` and `CANCELLED` are all terminal
   (phase-4 §3.1: terminal means terminal), so each of these buttons is an irreversible write with no
   confirmation step and no undo — the API is right to refuse a way back, which makes the absence of a
   prompt the screen's problem to solve.

---

# 5. Verification

```bash
pnpm lint && pnpm check-types && pnpm test
pnpm build
pnpm db:drift-check
```

## 5.1 Results — 2026-08-05

| Suite                      | Result                            |
| -------------------------- | --------------------------------- |
| `@bam/notification-engine` | 138 passed (was 92)               |
| `@bam/worker`              | 84 passed (was 63)                |
| `@bam/api`                 | 254 passed (was 250)              |
| `@bam/booking-engine`      | 89 passed                         |
| `@bam/availability-engine` | 76 passed                         |
| `@bam/contracts`           | 57 passed                         |
| `@bam/auth`                | 36 passed                         |
| `@bam/web`                 | 33 passed                         |
| `@bam/db`                  | 29 passed                         |
| `@bam/config`              | 14 passed                         |
| `@bam/observability`       | 5 passed                          |
| **Total**                  | **815 passed**, 19/19 turbo tasks |

`pnpm build` green, `pnpm db:drift-check` reports no drift.

**One pre-existing flake, not introduced here.** `billing.test.ts` → "sends an English organization
back to its English screen after paying" fails intermittently with a 404 on the invitation token,
and passes when `billing.test.ts` runs alone. Confirmed pre-existing by stashing every change in this
phase and re-running the API suite at `HEAD`, where it fails identically. Worth its own look: the
neighbouring log line is `Unique constraint failed on the fields: (provider_id)`, which suggests two
files in the suite are colliding on a fixture rather than anything about billing.

## 5.2 Still to walk by hand

The chain has no end-to-end test (§4.6), so these are the checks that matter, against a provisioned
organization (there is no `db:seed` — `pnpm db:grant-platform-admin`, then provision through
`/platform`):

1. Redis up (`docker/docker-compose.yml`, with a host port mapping), then `pnpm dev`.
2. Book through **`/{locale}/{tenantSlug}/book`** — e.g. `http://localhost:3000/en/wellness/book`.
   `/en/wellness` now redirects there (§3.5); before that it 404'd, and the 404 threw a hydration
   error (§4.8), so a walk that started at the short address looked like a broken booking page. The
   email arrives in the organization's language and its manage link opens `/booking/manage/{token}` —
   which proves the locale segment and the token both survived.
3. `select status, payload_json from outbox_events` and the same on `notifications`: both cleared
   after dispatch and send, and the reminder row PENDING, with a future `scheduled_at` and **no token
   in it**.
4. Reschedule from the manage page, then cancel. Two more emails; the cancellation offers a
   book-again link; the reschedule names the old time and no link of its own.
5. Set a service to `requiresApproval` and book it: a "request received" email that says it is _not_
   confirmed, then accept it from `/dashboard/bookings` and confirm a confirmation follows.
6. Backdate a reminder's `scheduled_at` in `psql`. The sweep picks it up within a minute; with
   `RESEND_API_KEY` unset the row must land `SKIPPED`, never `SENT`
   (phase-9-owner-onboarding-emails §2).
7. Cancel a booking with a pending reminder and wait for the sweep: the reminder must be `SKIPPED`
   with `BOOKING_NOT_LIVE`.
