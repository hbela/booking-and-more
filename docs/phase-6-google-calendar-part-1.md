> **PARKED on 2026-08-17 — read §10 first.** The feature was built, reviewed, and then deferred for
> delivery time before it ever ran against a real Google account. Every module described below is still
> in the tree and still compiles; the four seams that *reach* them are commented out, so nothing in the
> product touches Google and no calendar rows are written. §10 is the inventory of what is commented and
> what to uncomment. Read the rest of this document as the design that is waiting, not as the behaviour
> of the running system.

This is the **record** of the first half of Epic 6's calendar synchronisation. Opened as a plan on
2026-08-16; every step in §7 landed on 2026-08-17, so the document is now history rather than intent.
**The code is done and the walk in §9 is not** — nothing here has been exercised against a real Google
account, and §4's verification submission has not been opened.

Epic 6's number was partly claimed already: [phase-6-booking-calendar.md](phase-6-booking-calendar.md)
delivered the customer's month view and said so in its §6 — "the staff calendar, Google Calendar sync and
per-step deep links remain unbuilt". This document takes the second of those three.

# Phase 6 — Google Calendar, part 1: connect and write

## Implementation Plan

**Document version:** 1.1 — planned 2026-08-16, built 2026-08-17, **parked 2026-08-17** (§10). Steps 0–12
complete; §9's manual walk never performed.
**Scope:** a provider connects their own Google account, chooses one calendar, and confirmed bookings
appear there, move when rescheduled, and grey out when cancelled. **Reading busy time back from Google is
part 2 and deliberately out of scope** — the availability engine's `externalBusyPeriods` seam stays empty
for one more phase.
**Depends on:** [phase-4-booking-engine.md](phase-4-booking-engine.md) (the outbox events this consumes) ·
[phase-5-notifications.md](phase-5-notifications.md) (the outbox → durable row → job → sweep chain this
copies wholesale) · [phase-3-availability-engine.md](phase-3-availability-engine.md) §5.2 (the seam part 2
will fill).
**Exit criteria (tech-impl §44, the part reachable without reads):** Confirmed bookings create calendar
events · Calendar failures do not invalidate bookings · Revoked access is detected and displayed.
**Not exit criteria here:** External busy periods affect slot results — that is part 2.

---

# 1. Context

A provider's appointments exist only in our database. Nothing reaches the calendar on their phone, and
nothing they block out in their own Google calendar protects them from being booked over. The second of
those is part 2; the first is this.

## 1.1 What was already left here

Epic 6 has been named in every phase record since Phase 0, and each one left a seam rather than a stub:

| Seam | Left by | State today |
| --- | --- | --- |
| `externalBusyPeriods` on `AvailabilityQuery` | phase 3 | declared, subtracted, hard-coded `[]` |
| `QueueNames.CALENDAR_SYNC` | phase 5 part 1 | the `Queue` is created at boot with no consumer |
| `CALENDAR_DISCONNECTED` | phase 5 part 1 | enum value + template *name* + a designed dedupe key; **no renderer** |
| `ExceptionSource.CALENDAR`, nullable `createdByUserId` | phase 2 | "null when the platform created it — a calendar sync, for instance" |
| `encryptedRefreshToken`, `authorizationCode` in `REDACT_PATHS` | phase 0 | already redacted, before anything could produce one |
| The outbox tolerating non-`Booking` aggregates | phase 5 part 1 | "marking them processed without acting is correct until their consumers exist" |

Part 1 consumes the middle four. `externalBusyPeriods` is part 2's.

## 1.2 What this is not

[phase-5-booking-notifications.md](phase-5-booking-notifications.md) §2.6 added an "Add to Google Calendar"
link to the confirmation email on 2026-08-16. That is a `render?action=TEMPLATE` prefill URL — it holds no
token, reads no account, and cannot follow a later reschedule. Its own docblock disclaims being this. The
two are unrelated and both stay: the link serves the **customer**, this serves the **provider**.

---

# 2. Decisions

## 2.1 Working hours stay in the app

Nothing writes a provider's working hours or availability exceptions to Google, in this phase or a later
one.

A schedule is a wall-clock **rule** — "Mondays 09:00–17:00", which must still read 09:00–17:00 on the Monday
the clocks change (rule 13). A calendar event is an **instant**. Mirroring the first as recurring instances
of the second means re-deriving every DST case in a system whose recurrence rules are not ours, in exchange
for a read-only decoration.

What a provider actually wants from "sync my working hours" is that the commitments in their own calendar
carve into their bookable time. That is the **read-busy** half, and it is part 2. Saying so here stops the
question being reopened as though it were unconsidered.

Deriving hours *from* Google is refused outright: PRD §9.10 says the database remains authoritative, and
product objective #3 says Google must not become the sole source of availability.

## 2.2 One claim on the outbox, two legs

**The outbox is single-consumer, and this is a hard constraint rather than a preference.** `OutboxEvent`
carries one `status`, and `markProcessed` in `outbox.repository.ts` additionally *clears the payload*. A
second poller over the same rows would race the first for the claim and find an emptied payload if it won.

So the calendar leg runs **inside** `dispatchOne`, sharing the claim the notification leg already takes. One
outbox row fans out to two durable commitments.

The chain is then exactly the one phase 5 documents at the top of `outbox.dispatcher.ts`, twice over:

```
outbox_events ──┬─→ notifications           (commitment) → job (a prompt) → sender
   one claim    └─→ calendar_event_mappings (commitment) → job (a prompt) → processor
                                  ↑                                            │
                            calendar.sweeper ←──────────────────────────────────┘
```

Every link durable except the last, and the last deliberately not. If Redis loses every job, nothing is
forgotten: the rows are still PENDING and the sweep finds them.

**Notifications run first.** The customer's email is the higher-value commitment and must not wait on a
calendar table.

## 2.3 Idempotency comes from a derived event id

`events.insert` accepts no `Idempotency-Key`. It does let the caller supply the event's own id, and rejects
a duplicate with `409 duplicate`. So tech-impl §25.5's unelaborated "an idempotency strategy" is:

```
externalEventId = "bam" + base32hex(sha256(`${bookingId}:${calendarMappingId}`).slice(0, 20))
```

35 characters, every one inside Google's permitted base32hex alphabet. Derived from the same tuple as the
unique constraint, so it is computable *before* the row exists and the column is NOT NULL. It is a hash, so
no booking id of ours leaks into a third party's URL space.

Two layers, one guarantee:

- `@@unique([bookingId, calendarMappingId])` makes **our** row singular — the same mechanism as
  `notifications(tenant_id, dedupe_key)`, enforced the same way: attempt the insert, read P2002 as "already
  committed", never SELECT first (rule 14);
- the derived id makes **Google's** event singular even when a worker dies between Google's 200 and our row
  update. That is the case a unique index alone cannot cover, and the whole reason the id is derived rather
  than read back.

Cancellation is `PATCH status: cancelled`, never `DELETE` — permitted by PRD §9.10's "delete **or** cancel",
and chosen because a deleted id is not immediately reusable, which would break the guarantee above on a
booking that is cancelled and then reinstated.

## 2.4 Desired versus achieved, not one status column

`calendar_event_mappings` carries `desiredState` / `desiredVersion` / `syncedVersion` beyond tech-impl
§10.16's `sync_status`. One status column cannot express "cancelled, but the cancellation has not landed" —
it can only say the sync failed, which is a different fact.

`desiredVersion` is `Booking.version`, which every booking write already bumps. That is what distinguishes
reschedule #1 from reschedule #2, exactly as it does for the customer's email.

It also buys the guard that makes out-of-order delivery survivable. The upsert carries
`WHERE desired_version < EXCLUDED.desired_version`, so a redelivered `BOOKING_RESCHEDULED` cannot resurrect
the event of a booking that has since been cancelled. Outbox rows are claimed oldest-first, but a retry
reorders them, and that must be survivable rather than assumed away.

## 2.5 Our own OAuth flow, not Better Auth's

Better Auth already does Google sign-in and writes tokens into `accounts`. This does not reuse it, for three
reasons in increasing order of weight:

1. Those tokens are stored **in plaintext**. PRD §9.10 requires refresh tokens encrypted at rest.
2. A provider may want to connect a different Google account from the one they sign in with — and a provider
   who signs in with email and password has no Better Auth Google account at all.
3. [phase-1-authentication-and-tenancy.md](phase-1-authentication-and-tenancy.md) §2 is emphatic that Better
   Auth owns **identity only**. An integration is not an identity, and the predecessor project's trouble
   came from exactly this kind of conflation.

The client *credentials* are shared — one `GOOGLE_CLIENT_ID`, one consent screen, one verification
submission. Only the flow is ours.

## 2.6 What the event says, and what it does not

`{service} — {customer}` as the title, phone and notes in the description, `location` when the booking names
one.

**No attendees, and `sendUpdates=none`.** Adding the customer as an attendee would make Google email them
about an appointment we already email them about, from an address they do not recognise, in a language
nobody chose. The customer's relationship is with the clinic.

The customer's name **does** travel to Google. That is a deliberate PRD §13.3 decision rather than an
oversight: a diary entry a provider cannot identify at a glance is close to useless, which is most of the
reason to sync at all. Recorded here so it can be found; a tenant-level setting to reduce it to the
reference is the obvious later concession if a customer objects.

The event span is the **appointment**, not the occupied span. Buffers are our arithmetic; a calendar entry is
for a human. Same distinction [phase-3-4-schedule-conflicts.md](phase-3-4-schedule-conflicts.md) §2.2 draws,
for the same reason.

Nothing ever identifies a booking by its title (PRD §9.10). The mapping row does, and
`extendedProperties.private` carries the booking id as a second route home for part 2.

## 2.7 Hand-rolled `fetch`, not `googleapis`

The same call this repo made for Resend in `email.provider.ts`, and the opposite of the one it made for
Stripe — so the reasoning matters.

Stripe earned its SDK: dozens of resources, webhook signature verification, and a typed API surface that
would be a large hand-rolling. Google Calendar here is **six endpoints**. Against that, `googleapis` is a
very large dependency, and it flattens failures into its own error classes.

That flattening is the deciding objection, because the failure *shape* is the product here. Tech-impl §26.3
requires that `invalid_grant`, an invalid calendar id and permission-denied are never retried — and **403 is
not one thing**: `rateLimitExceeded` must retry, `insufficientPermissions` must not. Classifying that needs
the status code and the `reason` field, which is precisely what an SDK error class loses.

## 2.8 The callback answers a redirect, never an error envelope

Every other route in this API answers JSON to a program. `GET /v1/integrations/google/callback` is
reached by a **person's browser**, handed back by Google, so whatever it returns is rendered as a page.
An `AppError` envelope there would be a blob of JSON in somebody's address bar at the one moment they
are least equipped to read it.

So `IntegrationService.completeConnect` never throws. It returns a `{ outcome, redirectTo }` pair and
the route sets a header. The outcome is a **closed union of short reasons** — `access_denied`,
`invalid_state`, `session_mismatch`, `exchange_failed`, `missing_scope`, `no_refresh_token`,
`provider_gone` — rather than a message, because it travels in a query string and the integrations
screen renders it in the reader's own language. A server-composed English sentence in a URL would be
neither translatable nor trustworthy.

Three consequences worth stating, because each is a bug that this route shape invites:

- **The return path is validated twice**, once by `returnPathSchema` at connect time and again in
  `compose()` on the way out. It is stored server-side rather than round-tripped through Google — but a
  stored redirect target deserves no more trust than a submitted one, and this is the moment it becomes
  a `Location` header. Three forms are refused: anything not starting with `/`, a leading `//` (which is
  protocol-relative and means *another host* — the spelling that defeats a naive "must start with a
  slash" check), and a backslash anywhere (browsers normalise `\` to `/`).
- **Unknown, expired and already-burned states are one answer.** Distinguishing them would let somebody
  probe for live handshakes.
- **The session check is defence in depth, not the control.** The 256-bit state secret is what
  authorizes the callback; matching `state.userId` against the signed-in session is what additionally
  stops a callback URL recovered from a shared machine's history being completed under somebody else's
  session. `session_required` and `session_mismatch` are separate outcomes although they redirect
  identically — the first is a browser that dropped a cookie on a cross-site redirect, the second is a
  real mismatch, and only one is worth investigating in a log.

## 2.9 Refreshing is the caller's job, staleness is the package's

`GoogleCalendarClient` takes an access token on every call and never holds one, because refreshing means
**persisting a newly sealed token** and only the caller has a database. A client that refreshed silently
would leave the row holding a token it had already replaced, and the next process to read it would refresh
again.

So the API refreshes in `IntegrationService.accessTokenFor` and the worker will do the same in step 7. What
is *shared* is only the decision of when — `isAccessTokenStale` in `@bam/google-calendar`, with a five-minute
margin. Two processes asking the same question with two different margins is the kind of disagreement that
stays invisible until a batch of writes fails halfway through.

The margin is generous deliberately. The alternative failure is a 401 in the middle of a run of calendar
writes, costing a retry cycle and an alarming log line to save one refresh call — and refreshes are cheap and
unmetered. It also absorbs clock skew, which is what makes a zero-margin check fail intermittently and
unreproducibly. `null` counts as stale: "I do not know when this expires" has one safe reading.

**A row is only ever revived by a success.** A refresh that works clears `NEEDS_RECONNECT` and `lastError`;
nothing else may. That is the same rule §3 of the subscription-lifecycle record states for Stripe events, and
it is here for the same reason — a guess that an integration is healthy again is a guess that fails silently.

When a refresh fails, `markNeedsReconnect` clears the access token along with setting the status. Leaving one
behind means the next caller sees a token, uses it, and gets a 401 it has to classify all over again — which
turns a clear "reconnect me" into an intermittent one.

## 2.10 One calendar per provider, and a bounded backfill

Selecting is a **single-valued setter**, not a whole-set `PUT`: the partial unique index from step 2 makes
"two writing calendars for one provider" unrepresentable, so there is no set to submit. That also keeps this
route outside phase-2-3 §2's whole-set rule rather than quietly bending it.

The index is doing the deciding, and `selectWriteCalendar` arranges to satisfy it — deactivating the previous
mapping in the same transaction as the upsert. Without that the request is refused by PostgreSQL rather than
by us, which is the right way round (rule 14) but a poor error message.

The previous mapping is **deactivated, never deleted**, because its `calendar_event_mappings` are the only
record of what we put in that calendar. Re-pointing therefore orphans the events already created (known limit
6) — the response names `replacedCalendarId` so the screen can say so, and nothing automatic is offered,
because the tidy-up would mean deleting real entries out of somebody's diary.

**The backfill exists because an integration that shows an empty calendar on the day you connect it looks
broken.** It is bounded by `CALENDAR_BACKFILL_LIMIT` (200, about three months for a full-time provider) and
takes the **soonest** appointments, not the most recent: this is the one burst the feature generates against
Google's per-user rate limit, and the entries worth having in a phone are the ones about to happen. Only
future `CONFIRMED` bookings qualify — §3.8 for `PENDING`, and nobody needs a calendar entry for an appointment
they have already been to.

It queues rows and writes nothing to Google. The API owns no queue — the outbox exists precisely so that it
does not — and `createMany({ skipDuplicates })` against the `(bookingId, calendarMappingId)` index means
re-selecting the same calendar is cheap and harmless rather than a read-then-write with a window in it.

`POST /sync` is the same idea for §25.6's "Retry": it resets `FAILED` rows to `PENDING` with a fresh attempt
budget and enqueues nothing. `SYNCING` rows are left alone because a live worker may hold one, and `PENDING`
rows are already queued — the sweep is what reclaims a stale claim, and it knows how long is too long.

### The consent that grants less than it was asked

Google's consent screen has checkboxes, so a provider can return having granted `userinfo.email` and
not `calendar.events`. That integration is **recorded** — the granted scopes are what make this
diagnosable as itself rather than as a 403 three days later — but recorded as `NEEDS_RECONNECT` with
the missing scope in `lastError`. `ACTIVE` is a claim that the row can do work, and this one cannot.

A *first* connection that comes back with no refresh token is refused outright instead, and nothing is
stored. `prompt=consent` is supposed to guarantee one (§7.1), so its absence is already unexpected —
and storing the access token alone would produce an integration that works until lunchtime and then
stops, with nothing in any log to say why. On a **re**-connection the stored refresh token is kept
rather than overwritten, which is the same failure approached from the other side: a re-consent that
returns only an access token must not let the repair create the fault.

---

# 3. Deliberate deviations from the specs

1. **`POST /connect`**, not PRD §19.4's `GET`. A `GET` that mints a single-use state row is a state-changing
   `GET`; `POST /v1/billing/portal` set this precedent already.
2. **`GET /v1/integrations/google` added.** §19.4 has no route for reading our own integration state, and
   the health panel needs one.
3. **`calendar_event_mappings` exceeds tech-impl §10.16** by `desired_state`, `desired_version`,
   `synced_version`, `attempts`, `next_attempt_at`, `claimed_at` — the first three per §2.4, the last three
   because §26.3's backoff has to live somewhere durable.
4. **`calendar_oauth_states` added.** §25.1 step 2 says "the API creates an OAuth state record" and never
   says where it lives. A table rather than a signed value, because single-use is the property that matters
   and a signed value cannot be burned.
5. **Cancel by `PATCH status: cancelled`** rather than `DELETE` — §2.3.
6. **One write calendar per provider**, enforced by a partial unique index. A narrowing of §10.15, which
   implies many. One booking, one event, one answer to "where is this appointment". Reversible by dropping
   the index; the code already loops over mappings.
7. **`packages/crypto` and `packages/google-calendar` are new workspace packages.** The specs name neither.
8. **A `PENDING` booking gets no event.** §25.5 says "after `BOOKING_CONFIRMED`". An appointment nobody has
   accepted appearing in a provider's diary is worse than its absence — the same reasoning that gives
   `BOOKING_REQUESTED` its own "this is not confirmed yet" email.
9. **`DELETE /v1/integrations/google/:integrationId`**, not §19.4's `DELETE /v1/integrations/google`. That
   path addresses *the* integration, and a tenant may hold several: the unique key is
   `(tenantId, providerType, accountEmail)`, so two providers connecting their own Google accounts is the
   ordinary case rather than an edge one.
10. **The callback answers `302` on every path, including refusal** — §2.8.
11. **`DELETE` is not behind `requireWritableTenant`.** A suspended organization must still be able to
    withdraw a third party's access to its providers' calendars. That is a right rather than a feature, and
    the same reasoning that exempts `POST /v1/billing/portal` (phase-9-customer-portal §2) applies with
    more force here.

---

# 4. Google verification — the long pole, and it is not code

`https://www.googleapis.com/auth/calendar.events` is a Google **sensitive** scope. Unverified, the app is
capped at **100 connected users** and every provider sees an "unverified app" warning screen before
consenting.

Verification requires a demo video, a publicly reachable privacy-policy URL and brand review, and takes
weeks. **Nothing in this codebase shortens it**, so the submission opens alongside step 1 rather than after
step 12, and the weeks run concurrently with the build.

`calendar.app.created` grants access only to a calendar the app itself created and avoids verification
entirely — and is not an option, because it cannot write into the provider's real diary, which is the
feature.

The cap is ample for a pilot. It is recorded in §8 as a known limit rather than treated as a blocker.

---

# 5. Data model

Four enums and four models, one migration. Enum values appended, never inserted.

- **`calendar_integrations`** — unique on `(tenantId, providerType, accountEmail)`, so reconnecting is an
  upsert and one tenant may hold several. Status `ACTIVE | NEEDS_RECONNECT | DISCONNECTED` — three values,
  and `lastError` carries the detail; a fourth would be a second place to ask "can this do work". `providerId`
  is nullable and `SetNull`: archiving a provider must not silently kill a live Google connection.
- **`calendar_mappings`** — one row per selected calendar, `providerId` NOT NULL and `Cascade` (a mapping
  with no diary is meaningless). `readBusy` / `writeBookings` are separate booleans per §10.15, so part 2
  turns one on rather than changing a shape. `syncToken`, `watchChannelId`, `watchExpiresAt` are reserved
  now and unused — that is what "design the store so a push channel can trigger the same job later" buys.
- **`calendar_event_mappings`** — §2.3 and §2.4.
- **`calendar_oauth_states`** — hashed, single-use, TTL'd, burned on use.

**Disconnect deletes nothing.** It sets `DISCONNECTED`, deactivates the mappings, clears the sealed tokens
and revokes at Google. Rows stay because §34.5 audits disconnection and the trail needs something to point
at, and because a reconnect should resume rather than restart. The events stay in Google too — they are real
appointments the provider still has to attend, and deleting somebody's diary on disconnect is one step from
what PRD §9.10 forbids. The confirmation dialog says so out loud.

---

# 6. Failure

A confirmed booking stays confirmed when sync fails. That is PRD §9.10 and tech-impl §25.6, and it is
asserted directly rather than implied — every processor failure test ends by re-reading `booking.status`.

`CALENDAR_DISCONNECTED` finally gets its renderer, modelled on `renderPaymentFailed` because it is the same
genre: an alarming email that must not read as an outage. Its load-bearing line is the PRD's promise said to
the person worried about it — *"Your bookings are safe. The platform is the record of your appointments; only
the copy in Google Calendar has stopped updating."*

It is addressed to `integration.userId`, because only that person can re-consent to their own Google account
— an owner cannot — falling back to the first ACTIVE `OWNER` when that membership has gone. The dedupe
variant `{ integrationId, dayIso }` already exists and nags once a morning. One honest caveat: a UTC-day key
means the nag lands on the day's first failure whenever that is, not at a civilised hour.

`templates.test.ts` currently asserts `isRenderable(CALENDAR_DISCONNECTED) === false`. That is a "not built
yet" assertion, and this phase inverts what it asserts rather than deleting it.

---

# 7. Build order

Each step compiles, lints and tests green on its own.

| # | Step | State |
| --- | --- | --- |
| 0 | This record, and the CLAUDE.md entry | **done** |
| 1 | `@bam/crypto`, config vars, redaction | **done** |
| 2 | Schema and migration | **done** |
| 3 | `@bam/google-calendar` — pure modules, then `fetch` | **done** |
| 4 | `INTEGRATION_MANAGE_*` permissions and policy | **done** |
| 5 | API: connect / callback / disconnect | **done** |
| 6 | API: calendars / select / sync / read, with backfill | **done** |
| 7 | Worker: the processor | **done** |
| 8 | Worker: the dispatcher fan-out | **done** |
| 9 | Worker: the sweep, and `worker.ts` wiring | **done** |
| 10 | `CALENDAR_DISCONNECTED` renderer and trigger | **done** |
| 11 | Web: the integrations screen | **done** |
| 12 | Close this record: manual walk, known limits | **done** |

**The acceptance criterion for step 8** was that every existing test in `outbox.dispatcher.test.ts` stays
green with no edit. With no integration configured the calendar leg is one indexed `SELECT` returning `[]`.
**Met**: that file is untouched and its 27 tests pass.

## 7.1 What steps 1–4 actually landed

- **`packages/crypto`** — `sealToken` / `openToken` (AES-256-GCM, `v1.<iv>.<ct>.<tag>` envelope so a
  future key rotation can accept two keys and re-seal on read), `parseEncryptionKey`, `looksSealed`,
  `safeEquals`. 26 tests, including that a wrong key and a tampered value report the *same* message —
  a decryption oracle that distinguishes them is how padding-oracle attacks start.
- **Config** — `GOOGLE_REDIRECT_URI`, `GOOGLE_TOKEN_ENCRYPTION_KEY` (64 hex, validated at boot),
  `CALENDAR_OAUTH_STATE_TTL_MINUTES`, `CALENDAR_SWEEP_INTERVAL_MS`, `CALENDAR_SWEEP_BATCH_SIZE`,
  `CALENDAR_MAX_ATTEMPTS` (8). `hasGoogleCalendar` and `hasGoogleSignIn` are separate helpers because
  sign-in without Calendar is the common deployment. The `superRefine` catches the dangerous
  half-configuration: a redirect URI with no encryption key means consent succeeds and *then* the
  callback cannot seal what it was handed — a failure after the irreversible step.
- **Schema** — two migrations. The second is hand-written for the partial unique index Prisma cannot
  express. `calendar-constraints.test.ts` proves all three rules, including that archiving a provider
  leaves a live integration alone (`SetNull`).
- **`packages/google-calendar`** — 66 tests, no network. `deriveEventId` is asserted against Google's
  actual id rules (`/^bam[0-9a-v]{32}$/`), and the 409-is-success path is tested directly.
  `google.errors.ts` is table-driven over §26.3; the row that earns the file is that **403 is not one
  thing**.
- **Permissions** — `INTEGRATION_MANAGE_ALL` / `_OWN` and `canManageIntegration`, mirroring the
  availability pair. An ASSISTANT is refused: the front desk manages bookings and no settings, and
  attaching a Google account is a setting.

Two things worth knowing before step 5. `GOOGLE_CALENDAR_SCOPES` asks for `calendar.events` and
`userinfo.email` only — **not** `calendar.readonly`, which is part 2's and deliberately deferred so
the consent screen asks for nothing it does not yet use. And `buildAuthorizationUrl` forces
`prompt=consent` on every connect: without it Google issues a refresh token only on the *first* ever
consent for a client/user pair, so a provider who disconnects and reconnects would get an integration
that dies at the first access-token expiry, an hour later, invisibly.

## 7.2 What step 5 landed

`apps/api/src/modules/integrations/` — three routes, 20 integration tests in `integrations.test.ts`.

| Route | What it does |
| --- | --- |
| `POST /v1/integrations/google/connect` | Mints a single-use state row, returns Google's consent URL |
| `GET /v1/integrations/google/callback` | Burns the state, exchanges the code, seals the tokens, redirects |
| `DELETE /v1/integrations/google/:integrationId` | Clears the credentials, stops the calendars, revokes |

- **`google.client.ts`** memoises the OAuth client exactly as `stripe.client.ts` does, and for the same
  reason: with the four variables unset the API boots unchanged and these routes answer **503, not 404**.
  That is asserted against a second `buildApp` given none of them — which is also how CI runs every other
  suite in the repo, so "the feature is absent and everything else still works" is the default case rather
  than a special test.
- **The test seam is `buildApp({ googleOAuthClient })`**, mirroring `paymentLinkClient`. It replaces the
  network layer and **does not enable the feature**: whether calendar sync exists is `hasGoogleCalendar(env)`
  alone. A seam that also switched the feature on would make the 503 path untestable in the same file.
- **The state row is burned by an `updateMany` guarded on `consumedAt`**, so two callbacks racing on one
  handshake are separated by PostgreSQL and not by application code (rule 14). `claimOauthState` is the one
  repository method here with no `tenantId` argument, and the comment on it says why: the callback arrives
  with nothing but a state value, so requiring the tenant would be circular. `claimInvitation` has the same
  shape for the same reason.
- **Only a SHA-256 of the state reaches the database**, the same discipline invitation tokens get.
- `GOOGLE_TOKEN_ENCRYPTION_KEY` is parsed by `parseEncryptionKey` **at boot**, in the composition root, so a
  malformed key fails a deployment rather than one provider's callback.

The assertion the step exists for is `integrations.test.ts`'s "seals both tokens before they touch the
database": the stored value must not *contain* the plaintext, must satisfy `looksSealed`, and must open
back to the original under the configured key. The first two catch "forgot to seal"; the third is what
proves it was sealed with *this* key rather than merely encoded. The disconnect test closes the loop from
the other end — the token handed to Google's revoke endpoint is the plaintext, which can only be true if
the API opened what it sealed.

**What step 5 deliberately did not build:** the `GET /v1/integrations/google` state route, calendar listing
and selection, and the backfill. Those are step 6, so step 5's tests read the database directly rather than
through a route that does not exist yet.

## 7.3 What step 6 landed

Four more routes on the same module; `integrations.test.ts` is now 34 tests.

| Route | What it does |
| --- | --- |
| `GET /v1/integrations/google` | Connections, their calendars, and the §25.6 sync counts |
| `GET /v1/integrations/google/:id/calendars` | Asks Google, live, for writable calendars |
| `POST /v1/integrations/google/:id/calendars/select` | Points a provider at one calendar, queues the backlog |
| `POST /v1/integrations/google/:id/sync` | Requeues parked rows — §25.6's "Retry" |

- **§2.9** (token refresh) and **§2.10** (one calendar, bounded backfill) are the decisions; both are new in
  this step and written up above.
- **`CALENDAR_INTEGRATION_INACTIVE`** is a new error code, and the distinction it draws is the point: *this
  connection* needs a human (409) versus *this platform* has no Google credentials (503). The screen gives
  opposite instructions for the two, so a single code would tell somebody the wrong thing to do.
- **The read route filters rather than refuses.** A provider asking for the integrations page gets the page,
  showing what is theirs; a 403 would be right for one row and wrong for the screen. `canManageIntegration`
  is applied per row in the handler, which is the same `:all`/`:own` split as everywhere else (rule 10).
- **`configured` is reported, not inferred.** "Nobody has connected a calendar" and "this platform cannot
  offer calendars" both produce an empty array and need opposite words.
- `CALENDAR_BACKFILL_LIMIT` is the one new environment variable (default 200).

Two tests carry more than their share. "refreshes a stale access token and re-seals the replacement" asserts
that Google was called with the *new* token, that the new one round-trips under the configured key, and that
the refresh token was left alone — the last is the failure §2.8 describes, approached from the other side.
"marks the connection as needing a human when the grant is gone" is `invalid_grant` arriving as a **400**,
which is the whole reason `classifyGoogleFailure` reads the reason before the status.

**What step 6 deliberately did not build:** any write to Google. The API never calls `insertEvent`,
`patchEvent` or `cancelEvent` — the stub in the test suite rejects all three, so the day one is called from
here the suite says so. Those belong to the worker, which is step 7.

## 7.4 What step 7 landed

`apps/worker/src/calendar/` — the processor, its token half, and the `calendar-sync` consumer. 17 tests
against a real PostgreSQL and a fake Google.

- **`calendar.processor.ts`** — claims the row, resolves a token, performs the write, records the outcome.
- **`calendar.tokens.ts`** — the sibling of the API's refresh, per §2.9. Whoever discovers a dead grant
  records it, rather than leaving the caller to remember.
- **`calendar.worker.ts`** — concurrency **3**, deliberately below the notification worker's 5. Google allows
  roughly 600 requests per minute per user, the backfill is the one bursty workload, and nobody is waiting on
  a calendar entry appearing four seconds sooner.
- **One job name, not three.** `sync-calendar-event` — the row's `desiredState` and `syncedVersion` already
  say whether this is a create, an update or a cancellation, and they say it at the moment the job *runs*
  rather than when it was queued. A `create-` job that found a cancelled booking would have to ignore its own
  name anyway.

### The rules this step settled

**`booking.status` is never written, on any path.** Asserted at the end of every failure test rather than
once in a summary, because the value of §25.6's promise is per-path.

**An attempt that never reached Google is not an attempt.** Three conditions release the row *without*
counting the attempt — the integration is not `ACTIVE`, the grant is unusable, or a `RECONNECT` came back
from the Calendar call — and each waits an hour rather than backing off. Burning the budget there would park
every pending row before the provider had a chance to reconnect, which turns §5's "a reconnect should resume
rather than restart" into a lie. A **deselected calendar** is the opposite case and is parked at once: no
amount of waiting brings one back.

**`nextAttemptAt` is in the claim predicate**, not checked after it. A job arriving before its backoff has
elapsed must never take the row, and testing it afterwards means releasing something we should not have held.

**The success write is conditional on `desiredVersion`.** This is §2.4 doing its job: a reschedule landing
while we were talking to Google leaves the row `PENDING` at the newer version rather than `SYNCED` at the
older one — the difference between a diary that is briefly behind and one that is permanently wrong. The
outcome has its own name, `SUPERSEDED`, and the etag is kept because it describes the event Google now holds.

**There is no `RETRY` outcome.** A transient failure *throws*, because throwing is what applies BullMQ's
backoff on top of the row's own. An outcome returned normally always means the job is finished with.

The test that earns the file is "reaches SYNCED when Google refuses the insert as a duplicate": a worker
killed between Google's 200 and our row update leaves an event carrying our id and a row that believes it
created nothing. The 409 is reconciled by patching, which also recovers the etag we never got to record.

## 7.5 What step 8 landed

`calendar.leg.ts`, called from `dispatchOne` after the notification work, plus 15 tests in
`calendar.leg.test.ts`. **`outbox.dispatcher.test.ts` is untouched and its 27 tests pass** — the step's
acceptance criterion, and the reason the leg had to cost nothing when nobody has connected a calendar.

**The desired state comes from the booking, not from the event type.** This is the subtle one, and getting
it wrong resurrects cancelled appointments in people's diaries: a redelivered `BOOKING_CONFIRMED` for a
booking that has since been cancelled would, read literally, ask for the event to be present. So the event
type means only *"this booking's calendar state may have changed"* and the booking's **current** status
decides what that state is — exactly the reasoning `loadBookingFacts` already applies to notifications one
function up. `PENDING` and `EXPIRED` map to no opinion at all (§3.8); `COMPLETED` and `NO_SHOW` map to
PRESENT, because removing a past appointment from somebody's diary is rewriting their history.

**The `desiredVersion` guard closes what remains.** Two dispatchers can read the booking at different
versions, and the one holding the older reading must not overwrite the newer. The comparison is in the
`updateMany`'s `where` rather than in a branch above it, so PostgreSQL decides (rule 14). Its test spells the
sequence out: confirm, cancel at version 3, then let the stale reschedule arrive carrying version 2 — the
row stays CANCELLED.

**PRESENT inserts; CANCELLED only ever updates.** No row means nothing was ever written to a calendar, so
there is nothing to grey out — inserting one would queue a job whose only work is to discover it has none.

Two smaller rules, each with a test:

- **A new desire resets a parked row.** What failed is not what is being asked for now, so a row parked
  `FAILED` against version 1 gets a fresh attempt budget for version 2.
- **The desire is recorded even while the integration is `NEEDS_RECONNECT`.** The desire is ours, the grant
  is Google's. Skipping would lose the booking entirely; recording is what makes a reconnection *resume*,
  and the processor holds the row until somebody re-consents.

### An intermittent worth knowing about, characterised in §7.9

## 7.6 What step 9 landed

`calendar.sweeper.ts` (9 tests) and the `worker.ts` wiring that finally *starts* the `calendar-sync`
consumer — until this step it existed with no producer running and nothing consuming it.

**Three things depend on the sweep and nothing else.** The backfill draining at all, since
`POST /calendars/select` queues rows and enqueues nothing; any backoff ever elapsing, since a row released
an hour out has no job pointing at it; and recovery when Redis loses a job, since a row is the commitment
and a job is only a prompt.

**Two passes, stale claims first**, so a row a dead worker left `SYNCING` goes back out in the same pass
rather than waiting another interval. `attempts` is deliberately *not* reset by the reclaim: the claim
already counted the try, and a worker that died mid-call may well have died because of it.

**What is never swept**, each with a test:

- **`FAILED` rows.** §26.3 forbids retrying a permanently-broken thing. A sweep that took them would make
  `FAILED` mean "slow" rather than "stuck", and leave the Retry button with nothing to mean.
- **Rows behind an integration that is not `ACTIVE`.** The processor would only hand them straight back, so
  enqueueing is a minute-by-minute churn of jobs that cannot work. When the provider reconnects, the next
  pass finds them — which is what "a reconnect resumes" means in practice.

### The job id is not the row id

`calendarJobId(row)` is `${id}:${desiredVersion}:${attempts}`, and the reason is a trap worth naming.
BullMQ refuses `add` for a `jobId` it already holds — silently, returning the job it has — and a finished
job lingers under `DEFAULT_JOB_OPTIONS`: a day for a completed one, **a fortnight for a failed one**. Keyed
on the row alone, a row whose job had already failed could never be enqueued again for two weeks, however
many times the sweep found it due. It would sit `PENDING` and look perfectly healthy, which is the worst
shape a bug can have.

`desiredVersion` and `attempts` only ever move forward for a given row, so an id is never reused while two
producers reaching for the same work in the same state still collapse to one job. **Correctness never rests
on this** — the processor's conditional `PENDING → SYNCING` claim is what stops double-processing; the id
only saves the queue from carrying jobs that would find nothing to do.

### Shutdown is three stages, not two

Producers, then consumers, then queues and the connection. Producers first is the load-bearing part: a
sweeper still running while its consumer closes would enqueue jobs nothing is left to take. They survive in
Redis, so nothing is lost — but the shutdown log would claim a clean drain that did not happen.

### The consumer starts only when Google is configured

Rule 4, and with a wrinkle worth stating: **the dispatcher's calendar leg writes rows either way.** It
cannot ask whether Google is configured, because a tenant's mappings are data rather than config. What is
absent without credentials is anything that could *drain* those rows — the same shape as running without
Redis, and recorded as such in §8.3. The worker says so at boot rather than leaving it to be inferred.

## 7.7 What step 10 landed

`renderCalendarDisconnected` in `@bam/notification-engine` (8 tests) and
`apps/worker/src/calendar/calendar.disconnected.ts`, the trigger. The last seam phase 5 left is closed:
`CALENDAR_DISCONNECTED` had an enum value, a template *name* and a designed dedupe key, and no renderer.

**`templates.test.ts` was inverted, not deleted.** Its "refuses a type with no template" case asserted
`isRenderable(CALENDAR_DISCONNECTED) === false` — "the last one left: staff-facing, and it arrives with
Google Calendar". It has arrived, so the assertion now says `true`, and a second line proves the gate still
*can* say no by asking about a type that does not exist. The point the test was making outlived the fact it
was asserting.

### The line the template exists for

> Your bookings are safe. The platform is the record of your appointments; only the copy in Google Calendar
> has stopped updating.

PRD §9.10's promise said to the person worried about it, and asserted to appear **before** the call to
action — somebody who reads two lines and stops must still have been reassured. Modelled on
`renderPaymentFailed` because it is the same genre: an alarming subject line that must not read as an
outage. Both share the shape *state the problem, state what still works, then ask for the one action*, and
the middle part is the one that is easy to omit and expensive to.

### Where it is written from, and why that is unusual

Every other notification is planned from an outbox event, because every other one originates in a request.
This one originates in the **worker** — a Google call came back saying the grant is gone — so there is no
event to plan from and the row is written directly. `dispatchBillingNotice` has the same shape for the same
reason. From there it is an ordinary notification: the sender renders it, the retry policy applies, the
sweep recovers it.

**The API deliberately sends nothing.** `translateGoogleFailure` marks the integration and stays quiet,
because a person is sitting in front of the screen and will read the banner a moment later. The worker's
failure is the invisible one — hours after a booking, with nobody watching — which is exactly why it is the
half that earns an email.

### Two rules about the recipient

**Once per UTC day**, keyed `(integrationId, dayIso)`. A dead grant fails *every* queued row, so without the
key this sends one email per booking — which is how a well-meant alert becomes the reason somebody filters
our address. The caveat phase 5 designed in stands: a UTC day means the nag lands on the day's first failure
whenever that is, not at a civilised hour.

**To whoever consented, while they are still of this organization.** Only they can re-consent to their own
Google account. The fallback needs stating precisely, because the obvious implementation is dead code:
`CalendarIntegration.userId` is NOT NULL and cascades, so the consenting *user* is always present and a
`?? owner` on the relation can never fire. What is reachable is that their **membership** has gone — removed
or suspended while the account lives on — and mailing a departed colleague about a clinic's diary is useless
and a small disclosure besides. So the test is an ACTIVE membership, not the existence of a row, and this
supersedes §6's looser wording above.

The trigger never throws. A failure to *tell* somebody the sync is broken must not also fail the sync work
that discovered it — the row is already marked, and that is the durable part.

## 7.8 What step 11 landed

`/dashboard/integrations`, a nav item, and an `integrations` namespace in both catalogues. The decision
logic is `lib/integration-state.ts` (14 tests); the component is thin.

### The ordering that made it a separate module

A connection that needs re-consent will usually **also** have parked events, because the grant died and
every row behind it failed. Both facts are true at once, and showing the wrong one offers a Retry button
that cannot work: requeued rows are handed straight back by the processor, so the provider presses it,
nothing changes, and nothing says why. So `resolveIntegrationHealth` decides `needsReconnect` **before**
`failed`, and `noCalendar` above both — an integration with nothing selected has no failures to report and
nothing to retry, only a choice nobody has made.

Written inline that is a ladder of ternaries in JSX where the ordering is invisible and untestable. As a
pure function it is asserted in a unit test instead of discovered by a provider. Same call `lib/member-diary.ts`
made, for the same reason.

Six states, one per connection: `disconnected` · `needsReconnect` · `noCalendar` · `failed` · `syncing` ·
`healthy`. The plan asked for five; `noCalendar` is the sixth because "connected" and "connected and
actually writing somewhere" turned out to need different words and a different button.

### Three smaller decisions

**`?calendar=` is narrowed, never interpolated.** `parseCallbackOutcome` maps the query parameter to a known
key or to `"unknown"`. Anyone can type that URL, so a message keyed off the raw value would put
attacker-supplied text on a signed-in screen — a phishing surface, and the test asserts a script tag and a
plausible support-scam sentence both collapse to `unknown`.

**Retry is absent rather than disabled when it could not work.** `POST /sync` refuses a non-ACTIVE
integration with `CALENDAR_INTEGRATION_INACTIVE`, so a visible-but-dead button would only produce an error
message. The re-point warning is shown *before* the choice for the same reason: known limit 6 is not
something to discover afterwards.

**The connect target comes from the membership when there is one.** A `PROVIDER` holds
`integration:manage:own` and not `provider:manage`, so the providers list is not even fetched for them —
their diary is the only answer. An owner gets a select. An ASSISTANT sees no nav item at all.

### One thing only the build caught

`useSearchParams()` opts a component out of prerendering, and without a `<Suspense>` boundary it takes the
whole screen with it — which `next build` **refuses** rather than doing quietly. Lint and `tsc` both passed.
The fix isolates the URL-dependent part in its own `CallbackNotice` component so only that suspends, rather
than wrapping the screen and losing its prerender. Worth knowing before adding the next screen that reads a
query string.

## 7.9 The `respects the batch size` intermittent

`outbox.dispatcher.test.ts`'s last test asserts that a claim with `batchSize: 2` returns 2. It has
intermittently seen **3**. It appeared during step 8 — which added queries to `dispatchOne` and so changed
the dispatcher's timing — and the same *class* of flake is already documented in this package's
`vitest.config.ts`, where an earlier one "needed only a slower dispatcher file to surface".

What was ruled out, so nobody repeats it:

| Hypothesis | How it was tested | Result |
| --- | --- | --- |
| The claim SQL is wrong | Direct probe: 3 rows, `batchSize: 2` | Returned 2 |
| Parameterised `LIMIT` is mis-bound | Probe of the same raw statement | Returned 2 |
| Concurrent claims corrupt the bound parameter | 200 rounds of two concurrent `batchSize: 50` claims followed by one at 2 | 0 over-claims |
| Another test file writing concurrently | Every pairing of the calendar files with the dispatcher file | All green |

It needs the full seven-file suite, and it did not reproduce in ten consecutive runs once instrumentation
was added — which is itself evidence that it is timing-sensitive rather than logical.

**It is not known to be a product defect.** `LIMIT` is inside the claim's `FOR UPDATE SKIP LOCKED`
subquery, so the statement cannot return more rows than it asks for; and even if it did, the batch size is a
throttle rather than a correctness bound — claiming three events instead of two dispatches three events
correctly. The dispatcher test file is deliberately **not** edited to accommodate it (that would trade a
visible flake for an invisible one). If it recurs in CI, the claim query is the last place to look, not the
first.

---

# 8. Known limits this phase carries

1. **Nothing is read from Google.** `externalBusyPeriods` stays `[]`. A provider can still be booked over by
   their own personal commitments — that is part 2, and it is the larger half of what people mean by "sync".
2. **Unverified-app cap of 100 connected users**, and a consent warning screen, until §4 completes.
3. **Redis is required to drain, and so is `hasGoogleCalendar`.** Rows are written either way — the
   dispatcher's calendar leg cannot ask whether Google is configured, because a tenant's mappings are data
   rather than config — but without Redis *or* without credentials nothing consumes them, and they accumulate
   PENDING exactly as notifications do. The worker says which at boot.
4. **No rate-limit token bucket.** Google allows roughly 600 queries per minute per user; the backfill is the
   only burst and the sweep's batch size is the throttle. The thing to add when a large tenant connects.
5. **A `PENDING` booking gets no event** (§3.8). The slot is still held by us, so nothing is oversold — but a
   provider reading only Google could self-book over it. Part 1 does not read Google, and the database is
   authoritative.
6. **Re-pointing a mapping orphans the events it already created.** The select screen warns before the
   choice; nothing automatic is offered, because the tidy-up would mean deleting real entries out of
   somebody's diary.
7. **One writing calendar per provider**, enforced by a partial unique index (§3.6). The loops already
   iterate over mappings, so relaxing it means dropping the index — but the integrations screen assumes one
   and would need a second look.
8. **The disconnection email is keyed to a UTC day**, so the nag lands on the day's first failure whenever
   that is rather than at a civilised hour (§7.7).
9. **`POST /sync` reaches only `FAILED` rows.** A row stuck `SYNCING` behind a dead worker waits for the
   sweep's five-minute reclaim instead — correct, but it means the Retry button is not a universal
   unstick-everything control, and nothing on screen says so.
10. **No screen shows per-booking sync state.** The integrations page aggregates counts; a provider asking
    "did *this* appointment reach my calendar" has no answer short of looking at Google. `calendar_event_mappings`
    holds it, so this is a view nobody has built rather than data nobody has.

## 8.1 Forward note for part 2

External busy time is a third way a confirmed booking can end up outside its provider's schedule — the
condition [phase-3-4-schedule-conflicts.md](phase-3-4-schedule-conflicts.md) built
`findUncoveredAppointments` and the **Outside schedule** badge for. When busy periods start flowing, decide
deliberately whether they feed that check.

Note the asymmetry before deciding: a working-hours save can be **refused** and re-sent acknowledged, and a
Google event cannot be refused at all. So only the badge half of that pair can apply, and the dialog half
has no counterpart here.

---

# 9. The manual walk

**Written, not yet performed.** Everything above is proved against a fake Google: 71 unit tests in the
package, 34 API integration tests, 43 worker tests, 14 in the web app. What none of them can prove is that
Google agrees — that the consent screen asks for what we think it asks for, that an event lands looking the
way a provider expects, and that revoking access at Google's end produces the failure our classifier is
written for.

## 9.1 Preconditions

- A Google Cloud project with the OAuth consent screen configured and
  `https://www.googleapis.com/auth/calendar.events` + `userinfo.email` requested.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` and `GOOGLE_TOKEN_ENCRYPTION_KEY`
  (`openssl rand -hex 32`) set, and the redirect URI registered **character for character** in the console.
- Redis running, and the worker started — without it every box below stops at "the row is PENDING".
- A test organization with one provider, one service, and at least three future confirmed bookings.
- A **throwaway Google account**. Steps G and H revoke access and are tedious to undo on an account somebody
  uses.

## 9.2 The checklist

### A. Connect

| | Check |
| --- | --- |
| A1 | `/dashboard/integrations` shows "no Google account is connected yet", not an error. |
| A2 | With `GOOGLE_*` unset the same screen says the **platform** has not set it up — different words, and the reason `configured` is reported rather than inferred. |
| A3 | Connect opens Google's consent screen in the **same tab**. |
| A4 | The consent screen asks for calendar events and the account's address, and **nothing else** — this is the assertion that catches a scope added by accident. |
| A5 | The unverified-app warning appears. Expected until §4 completes; note the wording for the verification submission. |
| A6 | Accepting returns to `/dashboard/integrations` with a green "connected" message. |
| A7 | The panel names the Google account, which may differ from the login address. |
| A8 | `select sealed_refresh_token from calendar_integrations` is a `v1.…` envelope and contains nothing resembling a token. |

### B. Refuse, and refuse oddly

| | Check |
| --- | --- |
| B1 | Cancelling at Google returns with "you cancelled", and `calendar_integrations` is empty. |
| B2 | Re-using the returned URL a second time says the link expired. |
| B3 | Opening the callback URL in a browser signed in as somebody else is refused. |
| B4 | Unticking the calendar permission on the consent screen produces the missing-scope message, and the row is `NEEDS_RECONNECT` — **not** ACTIVE. |
| B5 | Appending `?calendar=<script>alert(1)</script>` to the screen renders the generic message and no script. |

### C. Choose a calendar, and the backfill

| | Check |
| --- | --- |
| C1 | The picker lists only calendars the account can **write** to. Share one read-only with the test account and confirm it is absent. |
| C2 | Selecting one reports how many appointments were queued. |
| C3 | Within a sweep interval, those appointments appear in Google. |
| C4 | The title reads `{service} — {customer}`; the description carries the phone, the reference and a staff link. |
| C5 | **The event has no attendees** and the customer received no mail from Google. |
| C6 | The event's span is the appointment, not the appointment plus buffers. |
| C7 | A **cancelled** and a **pending** booking did *not* appear. |
| C8 | Selecting the same calendar again queues nothing and creates no duplicate events. |

### D. The booking lifecycle

| | Check |
| --- | --- |
| D1 | A new booking appears in Google within a sweep interval. |
| D2 | Rescheduling **moves** the existing event rather than creating a second one. |
| D3 | Cancelling greys it out — it is still visible, not deleted. |
| D4 | Reinstating a cancelled booking reuses the same event. This is what `PATCH status: cancelled` buys over `DELETE` (§2.3). |
| D5 | Deleting the event by hand in Google and then rescheduling **recreates** it. |

### E. Re-pointing

| | Check |
| --- | --- |
| E1 | Choosing a different calendar warns *before* the choice that existing events stay put. |
| E2 | After the change, new bookings go to the new calendar and the old events are still in the old one (known limit 6). |
| E3 | `calendar_mappings` has the old row `active = false` rather than deleted. |

### F. Failure and retry

| | Check |
| --- | --- |
| F1 | Stop the worker, make a booking, restart it: the appointment arrives. The row was the commitment. |
| F2 | Flush Redis with rows PENDING; the sweep re-enqueues them. |
| F3 | Park a row by hand (`sync_status = 'FAILED'`) — the screen says "sync failed / retry scheduled" with a Retry button. |
| F4 | Retry moves it back to PENDING and it syncs. |
| F5 | Throughout, **every booking is still CONFIRMED**. This is §25.6's promise and the one box that must never be ticked with a caveat. |

### G. Revocation ★ — the assertion no test can make

| | Check |
| --- | --- |
| G1 | Revoke access at `myaccount.google.com` → Security → Third-party access. |
| G2 | Make a booking. The worker's next attempt classifies `invalid_grant` and sets `NEEDS_RECONNECT`. |
| G3 | The screen shows the reconnect banner, **not** the sync-failed one — the ordering §7.8 exists for. |
| G4 | The `CALENDAR_DISCONNECTED` email arrives, addressed to the person who consented. |
| G5 | It leads with "your bookings are safe" **before** asking for anything. |
| G6 | A second failure the same day sends **no** second email. |
| G7 | Reconnecting resumes: the queued rows drain without pressing Retry. |

### H. Disconnect

| | Check |
| --- | --- |
| H1 | The confirmation dialog says events already in Google stay there. |
| H2 | After disconnecting, `sealed_refresh_token` and `sealed_access_token` are **null**. |
| H3 | The events are still in Google. |
| H4 | The account no longer lists the app under third-party access. |
| H5 | New bookings produce no calendar rows. |
| H6 | Reconnecting the same account **updates** the existing row rather than adding a second. |

### I. Permissions and language

| | Check |
| --- | --- |
| I1 | A `PROVIDER` sees the Calendar nav item and can connect only their own diary. |
| I2 | An `ASSISTANT` does not see the item at all. |
| I3 | An owner can connect on behalf of any provider, and sees every connection; a provider sees only theirs. |
| I4 | An English organization gets an English screen, an English email, and a reconnect link with `/en/`. |
| I5 | Tab order and focus rings work through the picker; the health badge's meaning survives with colour off. |

## 9.3 What ticking these boxes closes

Tech-impl §44's three reachable exit criteria: *confirmed bookings create calendar events* (C, D),
*calendar failures do not invalidate bookings* (F5), and *revoked access is detected and displayed*
(G). The fourth — *external busy periods affect slot results* — is part 2's and cannot be walked here.

---

# 10. Parked, 2026-08-17

Deferred for delivery time, the same day it was built and reviewed. The decision is scheduling, not a
reversal: nothing above is retracted, and the code was not deleted.

Two things made parking the cheap option rather than the expensive one. §9's walk had not been done, so
no user had ever seen the feature and nothing had to be taken away from anyone. And the code review in
[google-calendar-feature-code-review.md](google-calendar-feature-code-review.md) had just found that the
first real connection would fail anyway: the OAuth flow requests `calendar.events`, and the calendar
picker then calls `calendarList.list`, which that scope does not authorize. So the feature would have
been shipped un-walked *and* broken on its first screen.

## 10.1 What is commented out

Four seams. Everything else is untouched — the parking is deliberately at the edges, so the diff is
small and the thing being restored is the wiring rather than the logic.

| Where | What | Effect |
|---|---|---|
| [apps/api/src/app.ts](../apps/api/src/app.ts) | the `integrationRoutes` registration and its two imports | `/v1/integrations/*` 404s. Note it no longer **503**s — an unmounted module and an unconfigured one are different answers, which is why §7.2's two tests had to be skipped rather than re-pointed. |
| [apps/worker/src/outbox/outbox.dispatcher.ts](../apps/worker/src/outbox/outbox.dispatcher.ts) | the `dispatchCalendarLeg` call inside `dispatchOutboxBatch` | No `calendar_event_mappings` rows are written at all. `calendarQueued` stays on `DispatchSummary` and stays 0. |
| [apps/worker/src/worker.ts](../apps/worker/src/worker.ts) | `createCalendarWorker` / `startCalendarSweeper`, the `calendar?` field, both shutdown calls | The `calendar-sync` queue exists with no consumer, as before this epic. The boot log now says so unconditionally instead of only when `GOOGLE_*` is absent. |
| [apps/web/src/components/dashboard-shell.tsx](../apps/web/src/components/dashboard-shell.tsx) and the route folder | the nav item; `dashboard/integrations` renamed to `dashboard/_integrations` | No nav item and no route. The leading underscore is Next's private-folder convention, so the page still typechecks and still builds — it simply is not routable. |

Parking the dispatcher leg **as well as** the worker's consumer is the one choice here worth stating.
Either alone would stop calendar events reaching Google. Only the leg stops rows accruing for a drain
that is not running — the §8.3 condition, which is survivable while it is temporary and is not what a
feature parked for an unknown number of weeks should be doing.

Every commented block carries a `PARKED` marker, so `rg "PARKED — Epic 6"` is the inventory.

## 10.2 What was deliberately left in place

- **The schema and its migration.** Reverting them would mean a second migration to drop four tables
  and four enums, and a third to bring them back — three schema changes to deliver nothing. The tables
  are empty and cost nothing. Rule 1 is why this is not negotiable: migrations are forward-only, and
  `pnpm db:drift-check` stays green precisely because the schema was not touched.
- **`@bam/crypto` and `@bam/google-calendar`.** Both build and both keep their full test suites (26 and
  71). `@bam/crypto` is general-purpose sealing and is the obvious home for any future secret at rest.
- **The `GOOGLE_*` and `CALENDAR_*` config.** All optional, all unread while parked. Setting them now
  does nothing, which is the point: there is no half-on state to discover.
- **`INTEGRATION_MANAGE_ALL` / `INTEGRATION_MANAGE_OWN` and `canManageIntegration`.** Pure policy, no
  route asks for them. A permission nothing checks grants nothing.
- **`CALENDAR_DISCONNECTED`'s renderer** and the `integrations` message namespace in both locales.
  Removing translated copy is the one part of this that would be genuinely tedious to redo.
- **`calendar.processor.test.ts` and `calendar.sweeper.test.ts` — still running.** They call their
  modules directly, so they still pass, and they are what keeps the parked code from rotting silently.

## 10.3 What is skipped, and why not rewritten

Two suites are skipped whole, each behind a `const parked = true` that is the only line to delete:

- `apps/api/src/integrations.test.ts` (34) — every request would 404.
- `apps/worker/src/calendar/calendar.leg.test.ts` (15) — nine drive through `dispatchOutboxBatch`.

Neither was re-pointed at the new behaviour. A suite rewritten to assert 404 would be green, would prove
nothing, and would have to be written back from scratch — and the six leg tests that *would* still pass
are not worth keeping alone, because "the leg runs on the same claim" is the property that file exists to
assert.

## 10.4 Un-parking

1. **Fix the scope blocker first.** It is the reason the walk would have failed on its first screen, and
   it decides the OAuth flow: either request a scope that authorizes `calendarList.list`, or drop the
   picker in favour of the primary calendar. Note that changing the requested scope invalidates every
   grant already given — which today is none, and is exactly why this is cheaper to change now.
2. Work through the rest of the code review — unvalidated calendar selection, account-to-provider
   reassignment, disconnect ordering, the in-flight version race, missing HTTP deadlines, and the
   cancelled-event display mismatch.
3. Uncomment the four seams in §10.1 and `git mv _integrations integrations`.
4. Delete the two `const parked = true` lines; both suites must go green with no other edit.
5. Pass the Google credentials to the API and worker in the compose topology, and set `REDIS_URL` —
   the review found both missing, and without them the parking is indistinguishable from the deployment.
6. **Open the §4 verification submission before any of this**, not after. It has a multi-week lead time
   that no amount of code shortens, and it was never opened. The pause changes nothing about that.
7. Walk §9 against a throwaway Google account. It has still never been done.
