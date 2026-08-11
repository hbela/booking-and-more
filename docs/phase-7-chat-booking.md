This is the plan and execution record for Epic 7 — letting a customer find and book an appointment by
typing, through the same booking engine the form already uses.

# Phase 7 — Chat booking

## Implementation Record

**Document version:** 1.0 — planned 2026-08-10.
**Scope:** the conversation session and its opaque token; the structured command envelope; the pure
conversation state machine and its deterministic date resolver; `packages/ai`'s interfaces and their OpenAI
implementations; the tool allowlist that turns an intent into a call on the existing booking services; usage
metering and the per-plan quota gate; the chat panel inside the customer booking flow.
**Depends on:** [phase-4-booking-engine.md](phase-4-booking-engine.md) for `BookingService` and the hold
lifecycle · [phase-3-availability-engine.md](phase-3-availability-engine.md) for `searchSlots` and `zone.ts` ·
[phase-2-3-owner-management.md](phase-2-3-owner-management.md) for the public catalogue · phase-9's
`SubscriptionPlan` for what a quota is read against.
**Delivers PRD:** §8.2 chat mode · §9.12–§9.15 · §10.2–§10.4 · §11 cost control · §25.1/§25.2 ·
tech-impl §10.17/§10.18, §20–§24, §37, §44 Epic 7.
**Exit criteria:** A customer completes a booking by chat · Every write is explicitly confirmed against a
named pending action · Conversation state survives a page refresh · Chat uses the same booking APIs as the
form · A tenant's AI spend has a ceiling before the first paid call.

---

# 1. The framing

Three sentences decide the whole design.

**One conversation, two transports.** Voice (Epic 8, [phase-8-push-to-talk-voice.md](phase-8-push-to-talk-voice.md))
is `audio → text` followed by the *same* message endpoint chat uses. There is no voice-specific state machine
and no voice-specific tool path, which makes Epic 8's exit criterion — "voice and chat share one conversation
state machine" — true by construction rather than by discipline.

**The conversation prepares; the booking engine decides.** Every tool is a thin call into the existing
`BookingService`, `AvailabilityService` and `PublicCatalogueService`. No conversational code computes a slot,
a span, a hold expiry or a snapshot. Rule 14 is untouched: the exclusion constraint on `capacity_reservations`
still decides who got the slot, and the conversational path reaches it through exactly the same transaction
the form does.

**The model never holds state and never executes.** It returns a validated envelope; a pure state machine
decides what happens next; the API executes through an allowlist. PRD §9.15 states the rule directly — the
language model must not be the sole storage location for booking state — and the reason is that a model
asked to remember a `serviceId` will eventually invent one.

---

# 2. Where the endpoints live, and why not where the spec says

tech-impl §18 and PRD §19.3 name the endpoints `/v1/voice/sessions/...`. Both are overruled here, on two
counts.

**The prefix is `/v1/public`, not `/v1`.** This is an unauthenticated surface reachable by a stranger with a
tenant slug. Rule 12 says such a surface serialises through its own schemas under `modules/public/`, so that
adding a staff field cannot quietly publish it. A `/v1/voice/*` module sitting outside that boundary would be
the second place in the codebase deciding what a stranger may see, and the first one already exists for a
reason.

**The noun is `conversations`, not `voice`.** Naming the surface after one of its two transports would leave
the chat-only path — which is the larger one, and the one that works without a microphone or an API key —
living under a URL that misdescribes it. `channel` on the session records which transport a turn arrived by;
the URL does not need to.

Recorded as a deviation in the same spirit as [phase-2-3-owner-management.md](phase-2-3-owner-management.md)
§2.7's removal of `service_locations`: the spec is not wrong about what to build, only about where to put it.

---

# 3. The session and its token

`conversation_sessions` (tech-impl §10.17) carries `tenant_id`, `channel`, `locale`, `timezone`, `status`,
the machine state, a JSON state blob, `turn_count`, `expires_at`, and a **`token_hash`**.

The token is 32 random bytes, returned exactly once at session creation and stored only as a SHA-256 hash —
the same construction as the booking management token in `booking.repository.ts`, for the same reason: a
database dump must not be a set of live credentials. It travels in an `X-Conversation-Token` header rather
than the path, so that the multipart upload route does not have to carry a secret in a URL that ends up in
proxy logs.

**Every failure collapses to one 404.** Unknown conversation id, wrong token, expired session, right token
against another tenant's conversation — all return the same body. This mirrors `bookingLinkNotFound()` on the
public booking routes and exists so the endpoint is not an oracle for which conversation ids are real.

**Why a token at all, when the form path makes do with a client-chosen `sessionId`.** `BookingHold.sessionId`
is explicitly documented as "not a login and not trusted for authorization" — it decides which hold to *show*
somebody, and getting it wrong costs a stranger's five-minute hold. A conversation spends money on every
turn. A client-chosen string is the wrong key for that, so this one is server-minted.

---

# 4. The envelope, and the second validation

The command envelope (tech-impl §21) lives in `@bam/contracts` — `conversation.ts` — not in `packages/ai` and
not in the engine. It is Zod, and it is the vocabulary three separate things share: the AI package produces
it, the API consumes it, the web renders from it. That is what `contracts` is for, and it keeps the engine
dependency-free like its two siblings.

The rule that matters is §21's last line: **nothing executes before the parameters have been validated
against the intent-specific schema.** The envelope's `parameters` field is `z.record(z.unknown())` — passing
it does not mean the parameters are usable. `parseCommand()` does the second pass, and the tool layer only
ever receives a value that has been through it.

Confidence below a floor, or a non-empty `missingFields`, does not execute either. It asks one question
(PRD §10.3 — one question at a time) and stays where it was.

---

# 5. Pending actions: why a table

tech-impl §22.1 models a pending action as a field on the session's state JSON. It is a table here —
`conversation_pending_actions` — because of the sentence immediately after it: *a generic "yes" must never
confirm an unknown or expired action.*

Making that true means the confirm route has to prove four things at once: this action exists, it belongs to
**this** session, it has not expired, and it has not already been used. A row with a status and an
`expires_at` makes all four a database question with an index behind it. A JSON blob makes them four
application-code questions, and the fourth one — already used — is the one that gets forgotten and turns a
double-tap into a double booking.

The action id is in the URL path of the confirm route. There is no endpoint that means "confirm whatever you
were last talking about".

---

# 6. The tool allowlist

`conversation.tools.ts` is a map from intent to handler. Anything not in the map cannot run, whatever the
model emits (PRD §13.5). The three tiers are tech-impl §23's:

- **Read tools** execute immediately and only through `publicOnly: true` predicates — `listServices`,
  `getService`, `listProviders`, `getProvider`, `searchAvailableSlots`, `getBooking`.
- **Prepare tools** validate, detect conflicts, build a preview, take the hold through
  `BookingService.createHold`, and write a pending action. The conversation id is passed as the hold's
  `sessionId`, which the column's own comment already anticipates: "one browser tab or one conversation".
- **Confirm tools** require a live pending action for this session plus an `Idempotency-Key` (rule 16), then
  call `confirmBooking` / `confirmReschedule` / `confirmCancellation` with `source: CHAT`. This is the first
  code path in the product to set that enum value; it has existed unused since the booking engine landed.

`tenantId` is passed explicitly on every one of them (rule 5). A conversation cannot reach a staff route
because there is no entry in the map that leads to one.

**A conversation started anonymously can only book.** Reschedule and cancel operate on a management token,
which the customer must supply in the conversation; without it those two tools have nothing to address. This
is a deliberate limit of the slice, not an oversight.

---

# 7. Dates are resolved by us, not by the model

tech-impl §24's hybrid. The model extracts *expressions* — `"jövő kedden"`, `"next Tuesday"`, `"délután"` —
and the deterministic resolver in `packages/conversation-engine/src/dates.ts` converts them, using
`@bam/availability-engine`'s `zone.ts`.

**Never by adding an offset.** Rule 13 exists because a stored UTC offset is right for half the year; a model
asked to compute "next Tuesday at 2pm in Europe/Budapest" as an ISO instant will be an hour wrong twice a
year and confident both times. `zone.ts` already reports whether a wall-clock reading was skipped or repeated
by a daylight-saving transition, and that report is what the resolver returns as an ambiguity rather than
guessing.

The absolute date is shown on screen before any write (PRD §10.2). The confirmation card never says
"tomorrow".

---

# 8. Deterministic text, model-free

tech-impl §20: *prefer deterministic template responses for common booking steps.* `templates.ts` returns a
**message key and parameters**, not a rendered sentence.

Two things follow. Localization stays in the next-intl catalogs where the rest of the product's language
lives (§38), so a Hungarian reply is a translation rather than a prompt instruction that may or may not be
honoured. And the API never composes prose, which means the assistant's replies cannot drift, cannot be
injected into, and cost nothing.

The model is used for what only it can do: recognising intent, extracting entities, interpreting a date
phrase, asking a clarifying question, and mapping a spoken service name onto one of the tenant's actual
services.

---

# 9. Metering: the gate comes first

`usage_events` and `usage_aggregates` (tech-impl §37) with `assertAllowed({ tenantId, category,
requestedQuantity })` called **before** the paid call, never after.

**Why this lands in the same slice rather than after it.** Transcription and interpretation are the first
things in the product that cost money per request and can be triggered by a stranger who has not signed in
and is not paying us. Every previous variable cost — email — is triggered by a booking, which is gated by a
hold, which is gated by availability. This one is gated by nothing, so it needs the gate built with it.

**The aggregate is incremented in the same transaction as the event**, by an atomic `increment` on an
upserted row, not by a rollup job. The next request's gate reads that row; a job-based aggregate is a ceiling
that is always one interval behind, which is the same class of bug as checking availability with a `SELECT`
before the `INSERT`.

**The quota table lives in `@bam/contracts`** next to the entitlement table in `billing.ts`, for the reason
[phase-9-subscription-lifecycle.md](phase-9-subscription-lifecycle.md) §3 gives about that one: a rule about
what a plan is allowed to do belongs in one table that can be read in a single sitting.

**Over quota is not a dead end.** The API returns `AI_QUOTA_EXCEEDED`; the chat panel folds away and the
form is still there. PRD §12.4 requires a form fallback for every voice action, and a spent budget is one of
the ways an AI action becomes unavailable — the same path a missing `OPENAI_API_KEY` takes.

---

# 10. A missing key degrades one feature

Rule 4, applied. `getOpenAI()` constructs on first use and throws a `ServiceUnavailableError` carrying
`CONVERSATION_UNAVAILABLE` when there is no key. The API answers 503 on the conversational routes and nothing
else changes: the catalogue, slot search, holds, confirmations, reschedules and cancellations are all
unaffected, because none of them ever touch the package.

The web reads the same signal and does not render a chat box it knows will fail.

There is a predecessor for the failure this avoids —
[phase-9-owner-onboarding-emails.md](phase-9-owner-onboarding-emails.md) §2, where a provider that could not
deliver reported success anyway. The equivalent here would be an interpreter that returns an empty envelope
when it cannot reach the model. It must throw.

---

# 11. The chat panel is inside the booking flow

tech-impl §28 is explicit that the conversational interface lives inside the normal booking flow rather than
on a page of its own, and `booking-flow.tsx` is already built the way that requires: one route, one `Step`
state machine, one owner for the hold's whole life.

The assistant becomes a panel within it that *drives* those same steps. A customer can ask for a slot, then
tap a different one; can start by clicking a service and finish by typing. Two parallel booking journeys that
each own a hold is precisely what the single-route decision was made to avoid.

The confirmation card (PRD §9.14) is the same component the model-driven and the tap-driven path both reach.
A spoken or typed "yes" fills the card in; it does not bypass it. That is what makes "every write is
explicitly confirmed" a structural claim rather than a prompt instruction.

---

# 12. What was built

Delivered and green (`pnpm lint && pnpm check-types && pnpm test`, 23/23 turbo tasks):

| Area | Files |
|---|---|
| Schema | `packages/db/prisma/schema.prisma` + migration `20260810175159_conversations_and_usage_metering` — `conversation_sessions`, `conversation_messages`, `conversation_pending_actions`, `voice_interactions`, `usage_events`, `usage_aggregates` and eight enums |
| Contracts | `packages/contracts/src/conversation.ts` (envelope, per-intent parameters, `parseCommand`), `usage.ts` (`PLAN_QUOTAS`, `quotaFor`, `isWithinQuota`, `usagePeriodOf`), nine new `ErrorCodes` |
| Engine | `packages/conversation-engine/` — `machine.ts`, `pending.ts`, `dates.ts`, `templates.ts`, `turns.ts` |
| AI | `packages/ai/` — `types.ts`, `client.ts`, `interpreter.ts`, `transcription.ts`, `composer.ts`, `prompt.ts`, `pricing.ts`, `fake.ts` |
| API | `apps/api/src/modules/public/conversation.{routes,schemas,service,repository,tools}.ts`, `audio.ts`, `apps/api/src/modules/usage/` |
| Worker | `apps/worker/src/conversations/conversation.sweeper.ts` |
| Web | `apps/web/src/lib/conversation-client.ts`, `components/conversation-panel.tsx`, `components/push-to-talk-button.tsx`, the `conversation` namespace in both message catalogues |
| Tests | `packages/{contracts,conversation-engine,ai}/src/*.test.ts`, `apps/api/src/{conversation,voice,usage}.test.ts`, `apps/worker/src/conversations/conversation.sweeper.test.ts` |

## 12.1 Two things found while building it

**`updateMany` cannot write a relation, and TypeScript will not tell you.** The
repository's `update` originally took `Prisma.ConversationSessionUpdateInput` and cast to the `many`
variant. `booking: { connect: … }` compiled and failed at runtime with "Unknown argument `booking`".
The fix is to *name the type the query actually accepts* —
`ConversationSessionUncheckedUpdateManyInput` — which turns that class of mistake into a compile error
and means a foreign key is set as `bookingId`, which is what the column is called anyway.

**A scripted fake that repeats its first answer makes every assertion vacuous.**
`FakeIntentInterpreter` consumed its queue only when more than one answer remained, so the first
envelope was replayed forever. Twelve integration tests passed while testing one turn. It now shifts
on every call and repeats only once the queue is empty. Worth remembering because nothing about the
failure looked like a test-harness bug: every assertion was about the *product*, and the product was
fine.

---

# 13. What this slice does not do

Provider voice commands (PRD §31) — that is goal #1 and a separate slice. Realtime speech-to-speech
(PRD §8.4) — excluded from MVP by PRD §23 and unstarted by design. Paid cloud TTS. Audio retention to object
storage. Customer accounts. A Redis-backed rate-limit store, which remains the known gap it was.
