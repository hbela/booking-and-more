# Phase 6 — The booking calendar

## Implementation Record

Written 2026-08-15, after the first hands-on testing of the deployed app.

This is a partial claim on Epic 6's number. It delivers the **customer's** month view on the public booking
page and nothing else: the staff calendar, Google Calendar sync and per-step deep links that tech-impl §28
and the phase-4 record also file under Epic 6 remain unbuilt. See §6.

---

# 1. What was wrong

The "When" step was one `<input type="date">` and a list of times for that day. A customer whose chosen day
was empty had exactly one move: guess another date. Nothing on the page said which days were worth trying,
and the number of guesses somebody makes before deciding a business has no availability is small.

Testing `app.booking.appointer.hu` walked straight into it. A day showed nothing; the "next available" chips
added hours earlier ([phase 4 §3.4.1](phase-4-booking-engine.md)) then reported nothing free for a fortnight
either, and the finished calendar went on to report three empty months. A calendar makes emptiness legible;
it does not make it smaller.

## 1.1 What the emptiness actually was — `maximum_advance_days = 1`

Resolved 2026-08-15, and worth reading before trusting any screen in the dashboard about availability.

The service `arctisztitás` carried `maximum_advance_days = 1`: **today and tomorrow, and nothing else.**
`generateSlots` intersects that window and returns before it walks a schedule at all
(`bookingWindow`, packages/availability-engine/src/engine.ts) — so every downstream gate reported honestly
that there was nothing, while the Providers and Availability screens went on showing a live provider with a
full Mon–Fri week. Feeding the production values back through the engine reproduces it exactly: 0 slots on
every day at `advance: 1`, and 29 slots per weekday at the inherited 180.

It read as *totally* dead rather than intermittently dead because 2026-08-15 was a **Saturday**. A one-day
horizon from a Saturday is Saturday–Sunday, both outside Mon–Fri hours, so nothing was bookable at all.
Tested on a Tuesday it would have offered Tuesday and Wednesday and nothing beyond — a far louder clue.

Three things were wrong beyond the data:

1. **Nothing said what the number meant.** "Book up to (days ahead)" over an empty box gives no hint that
   blank inherits 180 days or that `1` means tomorrow. Both catalogue forms now state the horizon in words
   as it is typed, carry the default as a placeholder, and warn below seven days
   (`advanceNote` in `apps/web/src/lib/catalogue-form.ts`, with the incident in its docblock).
2. **The diagnostic buried it.** `db:explain-availability` printed the effective advance *after* the
   schedule, as a footnote to a healthy-looking provider. The booking window is now computed and reported
   **first**, measured in the provider's own zone, and when the requested date falls outside it the script
   says so and stops — because no schedule below can change that answer.
3. **Four rounds of investigation went to code that was correct.** Every gate held; the fault was one
   integer. The general lesson is in the ordering above: check the gate that can void the others before
   checking the others.

---

# 2. The decisions

## 2.1 A month grid, not react-big-calendar

The request was for `react-big-calendar`, "as in `booking-for-all`". Two things argued against copying it.

**The predecessor is a thin reference.** Its customer calendar is a read-only week view fed by a single
`GET /available-events` that pulls *every* unbooked slot for the next twelve months into one query key with
no date in it — `onNavigate` moves the viewport and refetches nothing, because there is nothing to refetch.
It hardcodes 08:00–20:00 while the org's own `availabilityStartHour` sits unused in the database, forces the
time gutter to English regardless of language, and carries ~200 lines of `!important` hex CSS in an inline
`<style>` block, in a project whose own design system forbids hex in `.tsx`. Its staff sibling needed 110
lines of manual `getBoundingClientRect` hit-testing because `onSelectSlot` would not fire reliably, and a
`MutationObserver` injecting `<td>`s to fix the agenda view. The idea is worth taking. The code is not.

**A time-axis grid is the wrong shape for this job.** Slots come off a 15-minute grid and are merged across
providers without deduplication, so an "anyone" week is ~160 blocks per provider — and the question a
customer is actually asking is not "what does Tuesday look like hour by hour" but "which days can I come
at all". A month grid answers that in one glance, reuses the time list we already had, and needs no new
dependency: `@bam/availability-engine` already exports the calendar arithmetic and `apps/web` already
depends on it.

`react-big-calendar` would have been the workspace's first date library too — `date-fns`, `dayjs`, `luxon`
and `moment` are all absent, deliberately, because rule 13 routes zone work through the engine.

## 2.2 One month per request — reversing "never widen the search"

The comment this replaces argued the opposite, and said so at length: *"widening every search would make the
engine do fourteen days of work to answer a question about one."* It is reversed here because **the question
changed** — the step now asks which days of a month hold anything — and because measurement did not support
the fear:

- **Server cost barely moves with range.** `searchSlots` makes `4 + 2N` round trips (service lookup,
  assignments, one `listBusyReservations` for every provider at once, then working hours and exceptions per
  provider) whether `dateFrom === dateTo` or spans 31 days. Widening multiplies only the rows two
  range-scoped queries return and an in-memory grid walk. A month past `maximumAdvanceDays` returns `[]`
  from `bookingWindow` before the walk begins, so paging forward is nearly free.
- **Request *count* falls**, which is what the 30/minute public limit actually counts. Guess-and-check spent
  one search per date tried plus a lookahead per empty one; the calendar spends one per month viewed, cached
  by react-query for a minute.
- **The payload is the part that grew.** Measured against a local fixture — one provider, Mon–Fri
  09:00–17:00, a 30-minute service — a September search returns 682 slots: **135,729 bytes, or 8,066 gzipped**.
  Three providers would be ~400 KB raw.

So compression, not a bespoke endpoint. A `/slots/days` summary route would save ~14 KB over gzip while
costing a public schema, a service method, integration tests, an OpenAPI entry, a second thing to keep in
step with `searchSlots`' `publicOnly` predicate, and a second request on every day click — which would
reintroduce the loading flicker the month view exists to remove.

**Revisit if** a real tenant's month exceeds ~100 KB compressed, or p95 of a 31-day search exceeds ~300 ms.
The component consumes only `Map<DateOnly, DaySummary>` and `Slot[]`, so a summary endpoint would be one
query function and an adapter, with no UI movement.

### 2.2.1 `@fastify/compress` was missing entirely

`apps/api` had cors, helmet, rate-limit and swagger and no compression at all, and nothing else in the stack
could supply it: the browser calls the API cross-origin, so the web app's server is not in the path, and
Coolify's Traefik does not enable the compress middleware by default. Registered `global: true`,
`threshold: 1024`, benefiting every list endpoint.

**`requestEncodings` is deliberately left alone.** The Stripe webhook verifies a signature over the raw
body; putting a decompression transform between the bytes Stripe signed and the bytes we check is how that
route breaks silently. All 254 API tests pass with it registered, webhook suite included.

## 2.3 An empty month asks the next month, not a wider range

The obvious lookahead — search the following 62 days — is *larger* than the month it supplements (~5,900
slots, ~1.2 MB raw), and the case that triggers it is a busy tenant, not a quiet one. Instead the page fires
the **next month's own query, with the same key shape**, and then the one after, capped at
`LOOKAHEAD_MONTHS = 2`.

Three things fall out of that. The payload is bounded exactly like any other month; pressing "next month"
afterwards is a cache hit rather than a request; and the "Next available" button's jump is instant, because
the month it jumps to is already cached. Past two months the honest answer is to telephone the business,
which is what `noSlotsAhead` says.

## 2.4 What a day cell may claim

Three rules, each of which is a lie avoided:

- **A day's count is distinct start times, not slot items.** The search merges providers without
  deduplicating, so three providers free at 09:00 arrive as three objects. Counting items would tell a
  customer a day has eighteen times when it offers six — and the grid would repeat that thirty times.
  `dedupeByStart` fixes the same double-vision in the time list, which had been rendering three identical
  "09:00" buttons since Epic 4.
- **Days borrowed from the neighbouring months are inert `<span>`s, not buttons.** They were never searched
  for. A dotless clickable cell would assert "nothing free here" about days we did not ask about.
- **Past days and empty days look alike and read differently.** Both are unbookable, so both are dimmed; the
  accessible name distinguishes `dayPast` from `dayUnavailable`, because a reader who cannot see the month
  needs to know whether it is sparse or simply over.

## 2.5 `aria-disabled`, never `disabled`

Every unbookable day is `aria-disabled="true"` and remains focusable. A real `disabled` button is skipped by
some screen-reader browse modes, and a reader who cannot reach the empty days cannot work out *why* the
month looks sparse — the emptiness becomes invisible, which is the failure this whole phase is about.

The rest of the grid follows the WAI-ARIA date-picker pattern: `role="grid"`, one `<button>` per day inside
a `role="gridcell"`, a roving tabindex so the month is one Tab stop rather than thirty-one, and arrow keys
routed through `nextFocusedDay` — which is a pure function, so the keyboard is table-tested rather than
click-tested.

**`aria-selected`, never `aria-pressed`.** Picking a new day deselects the old one; that is selection, not a
toggle.

**An arrow key that leaves the month changes the month.** Clamping at the edge is what makes the last week of
a month unreachable by keyboard, and `Home` on the 1st of a month starting on a Tuesday legitimately lands
in the previous one. Focus is only moved by the effect when a key press asked for it, guarded by a ref —
moving it on every `focusedDay` change would grab the caret on mount and again each time a month query
resolved.

## 2.6 The touch-target exception

Phase 11 committed to `min-h-11` (44 px) as the minimum target. **Seven columns of 44 px do not fit a
phone.** On a 375 px viewport, minus the page's `px-6` and the Section's `p-6`, the grid gets 279 px —
about 40 px per column, and 32 px at 320 px.

Height stays 44 px; width does not, and cannot. 44×44 is WCAG **2.5.5**, which is AAA. **2.5.8 (24×24) is
the AA target PRD §12.4 commits to**, and 36×44 clears it comfortably. This is the first written exception
to that commitment and is recorded here rather than fudged, in the manner of phase-11 §2.6.

## 2.7 Two zones on one screen, deliberately

A slot is an **instant** and is shown in the reader's zone — `Intl.DateTimeFormat` with no `timeZone`, as
the booking page has always done. A calendar cell is a **calendar square** with no zone at all, so every
date formatter here passes `timeZone: "UTC"` against a `T00:00:00Z` value: the date that goes in is the date
that comes out. Without it a cell labelled `2026-08-17` prints as Tuesday 18 August in Auckland — wrong, and
invisible to anyone west of UTC+12.

`localDayOf` is the seam between the two: it asks which local day an instant falls on, so a 23:30 slot is
filed under the day its printed time belongs to (CLAUDE.md rule 13).

### 2.7.1 A latent UTC bug fixed in passing

`useState(() => new Date().toISOString().slice(0, 10))` is the **UTC** day. At 01:00 CEST on 16 August it
answers the 15th. It had been a quiet off-by-one in the old date input's `min` since Epic 4; in a calendar it
decides which cell is today and which cells are inert, so it becomes visible. Now `localDayOf(...)`, and
held in state for the tab's life rather than read per render — a page left open overnight should not have
its selected day silently turn unbookable.

## 2.8 No new design tokens

`globals.contrast.test.ts` already asserts `--on-accent` on `--accent` at 4.5:1 and `--accent` on
`--surface` at 3:1, so the calendar is built from those: dot `bg-accent`, selected `bg-accent text-on-accent`,
today `ring-line-strong`, unbookable `text-ink-subtle`. Adding a token would have meant adding a contrast
assertion, and there was no colour the existing ramp could not express.

`buttonRecipe` is **not** used here — it is `brand-*`/`primary-*`, and the public booking page is the
`accent-*` ramp (phase-11 §2.2), which is the whole mechanism by which PRD §9.1 white-labelling becomes a
data change later.

The availability dot is a **shape** — present or absent — so nothing here depends on colour alone
(WCAG 1.4.1), and the count is in the accessible name regardless.

---

# 3. Delivered

| File | |
|---|---|
| `apps/api/src/app.ts` | `@fastify/compress`, responses only |
| `apps/web/src/lib/month-availability.ts` | all calendar arithmetic, pure — months, the grid, slot summaries, keyboard motion |
| `apps/web/src/lib/month-availability.test.ts` | 43 cases |
| `apps/web/src/lib/next-available.ts` | shrunk to the empty-month escape hatch; `localDayOf` moved out, `addDaysToDateOnly` deleted as a duplicate of the engine's `addDays` |
| `apps/web/src/components/booking-calendar.tsx` | the grid: presentational, keyboard, ARIA. No queries |
| `apps/web/src/components/booking-flow.tsx` | the "When" step, `useMonthSlots`, the UTC-today fix |
| `apps/web/src/messages/{en,hu}.json` | 2 keys removed, 1 Hungarian value corrected, 10 added |

The native `<input type="date">` is **gone rather than kept alongside**. Two co-equal controls for one value
is what the old suggestion chips' own docblock argued against — the page must keep one idea of the day being
shown — and a native picker opens its own calendar popup, which would have put two calendars on screen. It
also cannot express *which days have anything*, which is the only question being asked. Typed entry is
covered by PageUp/PageDown and Shift with them.

---

# 4. Verification

## 4.1 Automated

`month-availability.test.ts` covers the boundaries somebody would otherwise have to look up: the `2027-02`
grid, which is **the only month between 2026 and 2030 needing exactly four rows** and would render as four
real rows plus fourteen filler cells under a fixed 6×7; `PageDown` from 31 January landing on 28 February
rather than 3 March; `Home` on 1 September crossing back into August; the 2026-10-25 daylight-saving weekend;
and a loop over every month of 2026–2028 asserting the search range never breaches the API's 62-day cap.

191 web tests, 254 API tests, `lint`, `check-types` and `build` all pass.

## 4.2 By hand, against a local fixture

One provider, Mon–Fri 09:00–17:00, a 30-minute service:

- `POST /slots/search` for September returned **682 slots across 22 days, none at a weekend**, 31 starts per
  working day — 09:00 through 16:30 on the 15-minute grid, which is exactly what a 30-minute service closing
  at 17:00 should offer.
- The response carried `content-encoding: gzip`; identity 135,729 bytes against 8,066 compressed.
- The calendar was rendered to static markup in both locales. September 2026: 30 gridcells and five inert
  leading cells, **exactly one tabbable button and exactly one `aria-selected="true"`**, `aria-disabled="false"`
  on precisely the two days holding slots, and a day given three slot objects at two distinct starts
  announcing "2 times free" — the deduplication, visible in the accessible name.
- Hungarian rendered `2026. szeptember — válasszon napot` and weekday headers `H K Sze Cs P Szo V`, which is
  the case for taking month and weekday names from `Intl` rather than the message catalogue: a
  `{month} {year}` template would be wrong in Hungarian and nobody reviewing the English would notice.

## 4.3 Not done

**No browser walk.** There is no Playwright or headless Chromium in this workspace — tech-impl §39.6 assigns
end-to-end testing to Playwright and none is installed — and adding one was out of scope. The static-markup
render above proves the grid's structure and ARIA; it does not prove **focus movement, month navigation by
arrow key, or the screen-reader announcements**, all of which need a live DOM. §5 of
[the phase 9 manual checklist](phase-9-manual-test-checklist.md) is the model for what that walk should
cover; until it happens, the keyboard is proven only at the level of `nextFocusedDay`'s unit tests.

Also unwalked: dark mode in all three theme states, 400% zoom at 320 px, and the two timezone checks
(`Pacific/Auckland` just after local midnight, `America/Los_Angeles` just before) that would confirm §2.7 on
a real clock.

---

# 5. Known limits

1. **One provider absorbs every "anyone" booking.** `dedupeByStart` keeps the first slot per start, and the
   API sorts by `startAt` then `providerId`, so the same provider wins every tie. Stability is the property
   that matters here — a button that changes provider between renders books somebody a different person than
   they were looking at — but spreading the load is a real question, and it belongs in the API, which knows
   each provider's utilisation. Rotating or randomising in the browser would only make the choice unstable
   without making it fair.
2. **A month is fetched whole even when the customer wants one day.** Accepted, measured, and §2.2 names the
   thresholds at which it stops being acceptable.
3. **The week starts Monday for both locales.** Correct for `hu` and for `en-GB`; wrong for `en-US`, which
   this product does not serve. `WEEK_STARTS_ON` is the single line to change.
4. **No prefetch of the adjacent month.** It would double the worst-case bytes for a navigation many
   customers never make. The lookahead in §2.3 is the exception, and it only fires when the current month is
   empty — which is exactly when it is cheap.

---

# 6. Still Epic 6's, and still unbuilt

- The **staff** calendar. `bookings-screen.tsx` remains a filtered list, and its docblock's reasoning stands.
- **Google Calendar sync.** `externalBusyPeriods: []` is still empty in `searchSlots`; the engine subtracts
  it already, so that work supplies data rather than changing logic.
- **Deep links per step.** Explicitly still deferred: the booking flow is one route because a hold is live
  from the moment a time is picked and a real navigation between steps risks orphaning it (phase 4 §3.4).
  Nothing in this phase touches that argument — **do not add `?day=` on the strength of the calendar
  existing.**
