# Phase 12 — The chat's slot calendar

## Implementation Record

**Document version:** 1.1 — built 2026-10-17; §5 (the provider step) added the same day.
**Scope:** the chat offers times through the booking form's own month calendar and time grid, and a
time picked there reaches the server as data rather than as a sentence for the model to read.
**Depends on:** [Phase 6 — booking calendar](phase-6-booking-calendar.md) (the calendar and the
month search being reused), [the AI receptionist record](multi-tenant-ai-receptionist-implementation.md)
(the conversation pipeline).
**Status:** record. Automated tests pass; **not yet looked at in a browser** (§4).

# 1. What was asked

The chat answered "Október 26 Hétfő" with six times on 19 October. That half was a resolver bug, fixed
the same day: `resolveDateExpression` had no rule for a named month and day, so it read only the weekday
(`dates.ts`, `calendarDateIn`). The other half is the request this plan answers: **the chat should offer
times the way the booking form does**, through the same calendar and time grid, so a customer who uses
both sees one way of choosing a time.

The owner chose to **match the form and leave provider names out**. The form shows each start time once
and books whichever provider the API lists first (`dedupeByStart`, phase-6 §2.4); the chat showed
`okt. 19., H 09:30 / Hauser Max` and `okt. 19., H 09:30 / Dr Kiss Katalin` as two choices.

# 2. Decisions

## 2.1 One picker, two callers

The form's time step moves out of `booking-flow.tsx` into `components/slot-picker.tsx`: the month
query, the two-month lookahead, the "land on a day that has something" rule, the calendar, the time
grid and the empty-month status region. The form and the chat both render it. A second copy would
drift, and drift is what the owner reported.

Its state (`today`, the visible month, the selected day) lives in a `useSlotPickerState` hook owned by
the caller rather than inside the component. The form unmounts the step when a hold is taken and
remounts it when the hold expires, and the customer must come back to the day they were on. That is
the behaviour today, and moving state into the component would quietly lose it.

## 2.2 The picker reads the month itself; the chat tells it what to search

The calendar needs a whole month, and the chat's turn carries six slots. The browser calls the same
public `POST /v1/public/tenants/:slug/slots/search` the form calls. That route is already public and
rate-limited, so the chat gains no new surface.

What the browser lacks is **which service the conversation settled on**. The turn gains a
`slotSearch: { serviceId, providerId | null, date | null }` whenever the server searched for times,
including when the search found none. "Nothing on the 26th" followed by a month that shows the 27th
is exactly what the form's calendar exists for (phase-6 §1). It is stored in `state_json` beside
`lastSlots`, so a refreshed page replays it.

- `serviceId` is the conversation's own, already resolved from the catalogue. The model never supplies
  it (PRD §9.15).
- `providerId` is the customer's **preference**, not the provider of the last pick (§2.4). A
  reschedule pins it to the booking's provider, as `prepareReschedule` already does.
- `date` is set only when the customer named a single day. The picker then opens on that day. For a
  range or no date, it opens on the range's month and the usual first-available rule picks the day.

The six-slot `slots` list stays in the turn and in `lastSlots`. A typed "the first one" still resolves
against it server-side, and removing it is not needed for this change.

## 2.3 A pick is data, not a sentence

A click used to send `A(z) 2. időpontot kérem` (I'd like the 2nd time) for the model to read as
`SELECT_SLOT { slotOrdinal: 2 }`. A time from a month calendar has no ordinal. Writing out
"26 October 09:30" for the model would put a model between a click and a hold, which is the one place
a misreading cannot be shown to the customer before it happens.

`POST …/messages` gains an optional `slot: { startAt, providerId }`. With it, the turn skips the model
entirely and runs `SELECT_SLOT` with exactly those values through the same allowlist and `run()`. Every
guard before the model still applies: closed or expired session, turn limit, character allowance,
per-session rate window, idempotency, the chat claim. The customer's visible text (the formatted time)
is still recorded, so the transcript reads as it did. No AI call is reserved or spent.

It is accepted only while a picker is on offer (`slotSearch` is stored), so it cannot be used to jump
over the service step. The values are a claim, not a decision. `createHold` checks the instant is
actually offered (`assertSlotIsOffered`, `publicOnly`) and the exclusion constraint decides any race
(rule 14), exactly as for the form. A reschedule goes through `prepareReschedule`, which reads only
`startAt` and keeps the booking's own provider.

## 2.4 The picked provider is not the customer's preference

`collected.providerId` held both "the provider the customer asked for" and "the provider whose time
was held". With names visible that was harmless. With names hidden, a pick that fails
(`SLOT_NO_LONGER_AVAILABLE`) left `providerId` set to a provider the customer never chose, and every
later search in the conversation was silently narrowed to them. `forgetSlot` now restores the
preference recorded in `slotSearch`.

## 2.5 The picker speaks the page's language

The chat has its own language switch with four languages; the app's message catalogues have two
(`hu`, `en`). The picker uses the page's next-intl catalogue, like the form, so its labels and date
formats follow the page. The page language is the chat's starting language, so they differ only after
the customer switches the chat by hand. Giving the chat's de/fr a calendar of their own needs those
catalogues to exist first, and that is not this change.

## 2.6 Layout follows the container, not the viewport

The form switched to two columns at the `sm` viewport breakpoint. In the chat the picker sits inside a
narrower panel, so it now uses a container query (`@container`, two columns from `@lg`). In the form,
at 720px wide, that gives the same result.

# 3. What was built

1. **API.** `conversationSlotSearchSchema` on the turn and in `StoredConversationState`.
   `searchSlots` returns it, `NO_SLOTS` included. `run()` stores and returns it. Both lost-race paths
   (the pick itself, and a hold expiring under the confirmation card) return it so the calendar comes
   back. Replay returns it only while a time is still being chosen. The message body accepts `slot`,
   and `ConversationService.pick` is the model-free path. `forgetSlot` restores the preference.
2. **Web.** `components/slot-picker.tsx` holds `SlotPicker`, `useSlotPickerState` and
   `slotMonthQueryPrefix`. The form's time step is now one `<SlotPicker>`, and `booking-flow.tsx` lost
   the 338 lines that moved. The chat renders `ChatSlotPicker` in place of the six cards, sends a pick
   as `slot` with the formatted time as its text, and invalidates the cached months after every pick.
   The "option N" sentences and `SlotChoices` are gone.
3. **One behaviour change in the form.** "Nothing free on that day" no longer flashes while the month
   is still loading. The form never noticed, because it always opened with no day selected. The chat
   opens on a named day before its month has arrived.
4. **Tests** (`apps/api/src/conversation.test.ts`, "Picking from the calendar"): `slotSearch` names
   the asked-for day; it survives `NO_SLOTS`; a pick of a time outside the six-card list takes the hold
   with no model call and no usage row; a pick before any search is refused; an instant outside working
   hours is refused and the calendar stays; a hold lost under the card does not leave the held provider
   behind as a preference.

# 4. Not done

- **Not looked at in a browser.** The container-query layout in the chat panel, and the form's time
  step after the extraction, have been type-checked and tested but not seen.
- The six-slot `slots` list is still computed and sent, for typed ordinals (§2.2). The panel no
  longer shows it, so "the second one" now refers to a list the customer cannot see. Removing it, and
  `slotOrdinal` from the prompt, is a follow-up.
- A chat switched by hand to German or French shows the calendar in the page's language (§2.5).

# 5. The provider step

Asked for once the calendar was in: **after the service, the chat asks for the provider, and then
offers the calendar**, as the form does. Until then the chat went from the service straight to
"Which day works for you?" in words. The engine had a `SELECTING_PROVIDER` state and a prompt for it,
but nothing ever reached them.

## 5.1 The order is derived, not stepped

`stateFor` now reads: no service → `SELECTING_SERVICE`; no provider answer → `SELECTING_PROVIDER`;
no time → `SELECTING_SLOT`. **`SELECTING_DATE` is no longer derived.** The day is chosen in the
calendar, so it is not a question of its own. A day the customer volunteers ("a check-up on Monday")
is still resolved and kept in `dateFrom`/`dateTo`, and only decides where the calendar opens
(`slotSearchOf`).

"Anyone available" is an answer, and an absent `providerId` cannot say so. It is recorded as
`CollectedFields.anyProvider`. Choosing a name clears it and choosing "anyone" clears the name, through
`ToolOutcome.forget`, because merging partial results can set a field but never unset one.

## 5.2 Every question arrives with what answers it

`run()` attaches the provider list whenever the next state is `SELECTING_PROVIDER`, and the calendar's
`slotSearch` whenever it is `SELECTING_SLOT`, whichever tool ran. The provider question can follow a
tapped service, a typed sentence or a lost hold, and none of them has to remember to attach the list.
Replay re-attaches the provider list, or a refreshed page would ask the question with nothing to tap.

`searchSlots` asks before it searches. A name in the same sentence answers the question
(`listProviders` matches `providerQuery`). A reschedule never asks, because its provider is the booking's.

## 5.3 A tapped provider is data

`POST …/messages` accepts `provider: { providerId | null }` beside `slot`, through the same
model-free `pick` path (§2.3). The command is fixed server-side as `GET_PROVIDER_DETAILS`, so it still
runs through the allowlist, and `listProviders` checks that the id offers the service. A provider who
does not offer it gets the question again with the right list. A typed name or "mindegy" still goes
through the model: the prompt and the interpreter's schema gained `anyProvider`.

The panel lists "Anyone available" first, in the form's own words for hu and en (`booking.anyProvider`)
and the chat's own for de and fr.

## 5.4 What it costs

- The six-slot list is now produced only when a search runs after the provider is known, for example
  a day typed at the calendar. The ordinary path never produces it. §4's follow-up is now mostly moot.
- `conversation.ask.date` is unreachable through `promptFor` and stays in the catalogue.
- Tests: `machine.test.ts` walks the new order. In `conversation.test.ts`, every conversation helper
  answers the provider question by tapping "anyone", and three tests are new: the question and its list,
  including after a refresh; a provider who does not offer the service; and "mindegy" typed.
