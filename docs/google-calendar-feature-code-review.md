# Google Calendar synchronization code review

**Reviewed:** 2026-08-17  
**Scope:** the implementation recorded in [phase-6-google-calendar-part-1.md](phase-6-google-calendar-part-1.md), plus its API, worker, web, database, configuration, deployment, and tests.

## Executive summary

The implementation has a thoughtful durable-sync design: bookings remain authoritative in PostgreSQL, desired calendar state is persisted before work is attempted, Google event IDs are deterministic, and retries are idempotent. OAuth state is single-use, refresh tokens are encrypted, permissions are checked server-side, and the provider gets integration health and recovery controls.

It is nevertheless **not ready for a real Google account or the checked-in production topology**.

The immediate blocker is the OAuth scope set. The application requests `calendar.events`, then calls `calendarList.list` to populate the calendar picker. Google does not authorize that method with `calendar.events`; it requires a Calendar List or broader calendar scope. Consequently, the first real picker request will return 403, the application will mark the integration `NEEDS_RECONNECT`, and reconnecting will request the same insufficient scopes again.

The checked-in Docker Compose topology also leaves `REDIS_URL` commented out and does not pass the Google credentials to either the API or worker. In that deployment, the API reports calendar sync as unconfigured and the worker never starts the calendar consumer.

After those blockers, several correctness and lifecycle issues should be fixed before release: unvalidated calendar selection, unsafe account-to-provider reassignment, disconnect ordering and false revocation success, an in-flight version race, missing HTTP deadlines, and a mismatch between the promised cancellation display and Google's actual cancelled-event semantics.

This review did not change application code.

## 1. What the code does

### 1.1 Connects a provider's Google account

The integrations screen starts `POST /v1/integrations/google/connect` for a provider. The API:

1. checks whether the actor may manage that provider;
2. creates a 256-bit OAuth `state` secret;
3. stores only its SHA-256 hash in `calendar_oauth_states`, with the initiating user, tenant, provider, return path, and expiry;
4. returns a Google authorization URL requesting offline access and forced consent.

Google returns to `GET /v1/integrations/google/callback`. The callback atomically consumes the state, checks that the current session is the session that started the flow, exchanges the authorization code, reads the Google account email, encrypts the access and refresh tokens with AES-256-GCM, and upserts a `calendar_integrations` row. Callback failures are represented as short outcome codes and redirected to the localized integrations screen rather than rendered as raw JSON.

Relevant code:

- `packages/google-calendar/src/google.oauth.ts`
- `apps/api/src/modules/integrations/integration.service.ts`
- `apps/api/src/modules/integrations/integration.repository.ts`
- `apps/api/src/modules/integrations/integration.routes.ts`
- `packages/crypto`

### 1.2 Lets the provider choose a destination calendar

`GET /v1/integrations/google/:integrationId/calendars` refreshes the access token when it is within five minutes of expiry and asks Google for calendars with at least writer access. The web page displays this list. A selection is posted to `/calendars/select` and stored in `calendar_mappings`.

A partial unique PostgreSQL index permits at most one active writing calendar for each provider. Selecting another calendar deactivates the old mapping but deliberately leaves its Google events and local mapping history intact.

Selection also creates up to `CALENDAR_BACKFILL_LIMIT` pending event-mapping rows for future confirmed bookings, soonest first. The API does not write to Google directly; the worker sweeper discovers these rows.

### 1.3 Mirrors booking changes through a durable worker pipeline

Booking lifecycle changes already produce transactional outbox events. The outbox dispatcher first commits customer notifications, then calls the calendar leg using the same claimed outbox row.

For the provider's active writing mapping, the calendar leg stores a `calendar_event_mappings` row containing:

- the booking and calendar mapping;
- a deterministic Google event ID;
- desired state (`PRESENT` or `CANCELLED`);
- desired booking version and last synchronized version;
- pending/syncing/synced/failed state, attempts, backoff, claim time, etag, and last error.

It then prompts the BullMQ `calendar-sync` queue. The database row is the durable commitment; the job is only a prompt. A periodic sweeper re-enqueues due rows and reclaims stale `SYNCING` claims, so Redis loss does not lose the requested synchronization.

The worker creates an event for a newly confirmed booking, patches it after rescheduling, and patches its status to `cancelled` after cancellation. Event IDs are derived from the booking and mapping IDs, so a worker crash after Google's insert but before the database update produces a 409 on retry rather than a duplicate event.

Transient failures use exponential backoff with jitter. Permanent request failures park the event row. Revoked/invalid authorization marks the integration `NEEDS_RECONNECT`, leaves the booking unchanged, and queues a deduplicated `CALENDAR_DISCONNECTED` email.

Relevant code:

- `apps/worker/src/outbox/outbox.dispatcher.ts`
- `apps/worker/src/calendar/calendar.leg.ts`
- `apps/worker/src/calendar/calendar.processor.ts`
- `apps/worker/src/calendar/calendar.sweeper.ts`
- `packages/google-calendar/src/google.events.ts`
- `packages/google-calendar/src/google.calendar.ts`
- `packages/google-calendar/src/google.errors.ts`

### 1.4 Shows health and recovery controls

`GET /v1/integrations/google` returns connections, selected mappings, and aggregate synchronization counts. The web screen reduces these facts to disconnected, reconnect-needed, no-calendar, failed, syncing, or healthy states. It offers calendar selection, retry of `FAILED` rows, and disconnect. English and Hungarian messages are present.

Disconnect deactivates mappings, clears stored credentials, and attempts to revoke the Google grant. Existing Google events intentionally remain.

## 2. Issues and bugs

### Blocker 1: the requested OAuth scopes cannot list calendars

`GOOGLE_CALENDAR_SCOPES` requests only:

- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/userinfo.email`

However, `GoogleCalendarClient.listCalendars()` calls `GET /calendar/v3/users/me/calendarList`. Google's current `calendarList.list` reference permits `calendar.readonly`, `calendar`, `calendar.calendarlist`, or `calendar.calendarlist.readonly`—not `calendar.events`.

Impact:

- OAuth can complete and the row can be `ACTIVE`.
- Opening the calendar picker receives 403 `insufficientPermissions`.
- The classifier treats that as authorization loss and changes the integration to `NEEDS_RECONNECT`.
- Reconnecting repeats the same scopes, so the user is trapped in a loop and cannot select a calendar through the supported UI.

Why tests missed it: API tests inject a fake `GoogleCalendarClient`; they verify the app's behavior, not Google's scope enforcement.

Fix: add the narrow `calendar.calendarlist.readonly` scope (or deliberately choose a broader scope), update the missing-scope checks and consent/verification material, then exercise the picker with a real account. See Google's [CalendarList.list authorization requirements](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list) and [Calendar scope guide](https://developers.google.com/workspace/calendar/api/auth).

### Blocker 2: the checked-in deployment does not enable the feature

In `docker/docker-compose.yml`, `REDIS_URL` is commented out for the API and worker. No `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, or `GOOGLE_TOKEN_ENCRYPTION_KEY` is passed to either service.

Impact:

- the API reports `configured: false`;
- the worker's `hasGoogleCalendar(env)` is false, so it starts no calendar worker or sweeper;
- with Redis absent, all outbox/notification queue processing is idle as well;
- calendar rows, if produced in another topology, remain pending.

Fix: wire Redis and all four Google variables into the actual deployment definition/secrets, document the exact redirect URI, and add a deployment smoke check that asserts both `calendarSync: true` and active queue attachment at worker boot.

### High: calendar selection trusts an arbitrary client-supplied ID and name

The picker obtains a live list from Google, but `POST /calendars/select` accepts any non-empty `externalCalendarId` and optional `calendarName`. `IntegrationService.selectCalendar()` does not verify that the ID is in the account's current writable calendar list.

Impact:

- a direct API caller can select a nonexistent, read-only, or inaccessible calendar;
- the old valid mapping is deactivated before the bad selection is discovered;
- backfill rows are created and later park as failures;
- a caller can spoof the displayed calendar name.

Fix: on selection, refresh the token, retrieve/validate the calendar against Google, require writer/owner access, and derive `calendarName` server-side. Ideally combine validation and the local transaction as closely as practical, while acknowledging that the remote authorization can change immediately afterward.

### High: reconnecting the same Google account can silently move it to another provider

`calendar_integrations` is unique on `(tenantId, providerType, accountEmail)`. The OAuth callback upserts on that key and overwrites `providerId` and `userId`. It does not check whether the existing row belongs to a different provider.

This is plausible when a business uses one shared Google account for more than one provider. Connecting it for provider B silently reassigns provider A's integration to B while the old calendar mappings still retain provider A. Authorization and UI visibility are based on the integration's new `providerId`, so provider B may see or disconnect state that includes provider A's mappings and event counts.

Fix: choose and enforce one model:

- one integration per provider/account: include `providerId` in the unique identity and reconnect lookup; or
- one account-level grant shared across providers: remove provider ownership from the integration and authorize/manage each mapping explicitly.

For the present UI and permission model, the first option is the smaller correction. At minimum, reject a callback when the same account is already attached to another provider instead of silently moving it.

### High: disconnect waits for Google before disabling local work, and revocation can report a false success

`IntegrationService.disconnect()` calls `revokeQuietly()` before `markDisconnected()`, despite its comment saying revocation is best effort and local disconnection must not be blocked by a Google outage. There is no HTTP timeout. During a slow revoke, mappings remain active and workers may continue writing events. A hung request can delay the user's local disconnect indefinitely.

In addition, `GoogleOAuthClient.revoke()` ignores `response.ok`. Any HTTP response—including a 400 or 500—is treated as success, so `revokedAtGoogle` can be `true` when Google rejected the revocation.

Fix:

1. decrypt/capture the token needed for revocation;
2. atomically deactivate mappings and clear stored credentials first;
3. attempt revocation afterward with a short deadline;
4. check the HTTP status and report `revokedAtGoogle: false` on non-2xx;
5. consider a durable best-effort revocation job if retrying revocation matters.

### High: an in-flight older synchronization can overwrite a newer claim's state

When a booking changes during a Google call, `recordDesire()` changes the row back to `PENDING` even if an older worker currently owns it. A second worker can then claim the newer version. When the older worker completes, `succeed()` sees that its desired version was superseded and performs an unconditional update that again sets the row to `PENDING`, clears `claimedAt`, resets attempts, and stores the older synced version/etag.

That update can clobber the second worker's `SYNCING` claim. A sweeper or third job can claim the same row concurrently. Deterministic event IDs make duplicates unlikely, and a later patch should eventually repair ordering, but the claim invariant is broken and Google calls can overlap unnecessarily.

Fix: give each claim an attempt token/version and condition every terminal/release update on that token, or keep a row `SYNCING` while only advancing `desiredVersion` and let its current owner release the newer desire after completing. Add a deterministic test in which version 2 is claimed before version 1 returns.

### Medium: Google HTTP calls have no deadline or cancellation

All OAuth and Calendar calls use bare `fetch`. DNS stalls, a half-open connection, or a slow Google response can occupy an API request or worker indefinitely. In the worker, the five-minute stale-claim sweeper can then hand the same row to another worker while the first request is still alive.

Fix: apply `AbortSignal.timeout()` (with separately chosen connect/read deadlines), classify timeout aborts as retryable, and propagate worker shutdown cancellation where possible.

### Medium: cancellation behavior does not match the product copy or phase document

The worker patches `status: "cancelled"`, while the UI and phase document promise that the appointment will remain visible and “grey out.” Google's current Event resource describes a cancelled non-recurring event as a deleted event; clients should remove their copies, and such events can eventually disappear. The manual checklist also asks to “reinstate” a cancelled booking, but the booking state machine explicitly forbids `CANCELLED -> CONFIRMED`.

Impact: real Google UI behavior may not match the product promise, and manual checks D3/D4 are not valid acceptance criteria as written.

Fix: decide the intended product behavior and test it against real Google Calendar. If cancelled appointments must remain visibly in the diary, keep the event confirmed and patch its title/description/transparency/color to represent cancellation instead of setting Google's deletion status. Otherwise, change the copy and documentation to say the event is removed/cancelled. Remove the reinstatement check unless the booking state machine gains that transition. Google's [Event resource reference](https://developers.google.com/workspace/calendar/api/v3/reference/events) documents the status behavior.

### Medium: unreadable encrypted tokens are handled inconsistently

The worker explicitly treats an unreadable refresh token as `NEEDS_RECONNECT`. The API calls `openToken()` inside a general catch and classifies the resulting local exception as a network-like retry, returning 503 without changing integration state.

Impact: the calendar picker can repeatedly say Google is temporarily unavailable when the actual problem is a rotated/wrong encryption key requiring human or operational action.

Fix: catch token decryption failure explicitly in the API, mark the integration `NEEDS_RECONNECT` (or expose a distinct operational key-rotation state), and share token-resolution logic so API and worker cannot drift.

### Medium: the callback does not always honor its “always redirect” contract

`completeConnect()` calls `requireClient()` before validating or consuming state. If calendar configuration is removed between starting OAuth and receiving Google's callback, it throws a normal 503 error response rather than returning the documented 302 outcome.

Fix: make the callback route catch configuration/service failures and compose a safe callback redirect, or loosen the documented contract. A browser-facing redirect is preferable here.

### Low: OAuth state rows are never cleaned up

Expired and consumed `calendar_oauth_states` remain indefinitely. The expiry index helps lookup but no retention task deletes old rows.

Fix: add a bounded retention cleanup job and retention period. This is storage hygiene, not an authorization flaw; expired rows cannot be claimed.

### Low: the worker test suite has a reproducible isolation/reliability failure

The broader worker test run failed at `outbox.dispatcher.test.ts > respects the batch size`: expected two claimed events but received three. The phase record already describes this intermittent; in this review it reproduced both in the combined worker run and when that file was run serially. Calendar-specific worker tests still passed 43/43.

Fix: isolate the test's database rows/transaction or make the assertion observe only rows created by that test. If the SQL claim itself is suspected, add a repository-level concurrency test that asserts the returned row count can never exceed `LIMIT` against a clean schema.

## 3. What is already done well

- Booking creation and calendar I/O are decoupled; Google failure cannot roll back or invalidate a confirmed booking.
- Deterministic, Google-compatible event IDs close the crash window that a local unique constraint alone cannot close.
- The desired-version model is a good basis for out-of-order delivery, subject to the claim race above.
- `calendar_event_mappings` is the durable source of sync work; Redis loss is recoverable through the sweeper.
- OAuth state is random, hashed at rest, expiring, single-use, and bound to the initiating session.
- Refresh tokens are encrypted at rest, and sensitive values are included in log-redaction configuration.
- Permission checks occur server-side and distinguish “manage all” from “manage own.”
- Failure classification distinguishes transient rate limits from revoked permission and permanent request errors.
- Calendar failure notifications are deduplicated and explicitly reassure the provider that database bookings remain safe.
- The integration health reducer is pure and tested, keeping UI precedence deterministic.

## 4. Work required to complete part 1 (connect and write)

Do these in order:

1. **Correct the OAuth scopes.** Add Calendar List read access, update scope validation and consent copy, and add a test asserting every called Google method is authorized by the requested set.
2. **Enable the deployment.** Wire Redis and Google secrets into API/worker deployments, register the exact production callback URI, deploy the migration, and verify worker startup logs show the queue and calendar consumer active.
3. **Fix selection trust.** Validate the selected calendar live and derive its display metadata server-side.
4. **Fix ownership identity.** Prevent one Google account connection from being silently reassigned across providers.
5. **Fix disconnect semantics.** Disable locally first, enforce network deadlines, and check Google's revoke response.
6. **Fix synchronization claim concurrency.** Add a claim token/version and a regression test for two booking versions in flight.
7. **Decide cancellation UX.** Align implementation, English/Hungarian copy, and manual acceptance checks with observed Google behavior.
8. **Unify token error handling and callback behavior.** Make API and worker agree on corrupted/unreadable tokens and preserve the browser redirect contract.
9. **Stabilize the worker test.** A release suite should be repeatably green, not documented as intermittently failing.
10. **Perform the real-account walk.** Execute section 9 of the phase document after correcting it. Automated fakes cannot verify scopes, consent wording, Google UI rendering, revocation, or customer-email side effects.
11. **Complete Google verification.** Prepare the consent screen, privacy policy, authorized domains, demo video, test-user/publishing configuration, and sensitive-scope verification. Until then, treat the testing-user limit/warning as a pilot-only constraint.
12. **Add production observability.** Alert on growing pending/failed counts, repeated reconnect transitions, sweep lag, token refresh failures, rate limits, and oldest unsynced booking age. Never include tokens or authorization codes.

Part 1 should not be called complete until a real account can connect, list calendars, select one, backfill, create, reschedule, cancel according to the chosen semantics, survive Redis/worker interruption, detect revocation, reconnect, and disconnect in the actual deployment topology.

## 5. Work required to complete the full Google Calendar feature (part 2)

The current code implements only outbound booking writes. The PRD and Epic 6 also require Google commitments to affect availability and externally modified events to be detected.

### 5.1 Busy-time ingestion

- Add the minimum additional Google scope needed for free/busy or event reads; use incremental authorization and update verification material.
- Add the `external_busy_periods` local cache (tenant, provider, mapping, external event, start/end, status, last synchronized time) with tenant-safe constraints and indexes for range queries.
- Perform an initial bounded/full synchronization for each enabled read mapping.
- Support incremental synchronization with `syncToken`, including Google's 410-token-expired full-resync path.
- Normalize timed and all-day events, recurring instances, cancellations, transparency, and timezone/DST behavior into UTC busy ranges.
- Exclude or specially handle this application's own mirrored booking events so they do not double-count or create false conflict reporting.

### 5.2 Push notifications and reconciliation

- Create Google watch channels with unguessable channel tokens and store channel/resource IDs and expiry.
- Add a public webhook endpoint that validates channel identity/token/resource, acknowledges quickly, and only enqueues work.
- Renew watches before expiry and stop channels on disconnect/re-pointing.
- Add scheduled reconciliation because notifications are hints, not a complete durable event stream.
- Make initial sync, webhook-triggered sync, polling/reconciliation, and manual retry converge on the same idempotent job.

### 5.3 Availability integration

- Load cached busy periods in `AvailabilityService` instead of the current hard-coded `externalBusyPeriods: []`.
- Subtract them in the existing availability-engine seam for the correct provider and query interval.
- Define freshness behavior: maximum acceptable cache age, whether stale data fails open or closed, and what the customer/provider sees.
- Add integration tests proving Google busy intervals remove slots without making Google the booking lock or source of truth.
- Decide whether newly ingested external conflicts feed the existing “Outside schedule”/conflict badge for already-confirmed appointments.

### 5.4 External modification policy

- Detect edits/deletions of platform-created Google events using stored IDs/etags/private extended properties, never event titles.
- Decide explicitly whether the database overwrites external edits, reports a conflict, or imports allowed changes. The PRD says the database remains authoritative, so silent mutation of bookings from Google would be inconsistent.
- Surface per-booking sync/conflict state; aggregate counts cannot answer whether one appointment is current.

### 5.5 Product gaps carried by the present phase

- The PRD says “one or more calendars.” The current write path enforces exactly one active writing calendar per provider. Part 2 will likely need multiple read-busy mappings even if write remains single-valued.
- Re-pointing currently orphans old mirrored events. Define optional cleanup/migration behavior before offering frequent calendar switching.
- Pending bookings do not appear in Google, so providers relying only on Google can manually occupy a held time. Busy-time reads reduce external conflicts but do not solve visibility of pending platform requests; that is a separate product choice.
- Add per-booking synchronization status and an administrator recovery view for parked jobs.

## 6. Verification performed for this review

Commands were run against the current workspace:

| Area                                                  | Result                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| `@bam/google-calendar`                                | 71/71 tests passed                                                  |
| API suite (invoked with the integrations target)      | 301/301 tests passed; the package script ran all API files          |
| Calendar-specific worker tests                        | 43/43 tests passed                                                  |
| Web suite (invoked with the integration-state target) | 215/215 tests passed; the package script ran all web files          |
| Broader worker suite                                  | 127/128 passed; batch-size test failed (`expected 2`, `received 3`) |

These results demonstrate substantial application-level coverage. They do not validate Google's live OAuth scope enforcement or UI behavior, which is why the unperformed manual walk remains release-critical.

## 7. Recommended release gate

Release part 1 only when all of the following are true:

- no blocker/high finding above remains;
- targeted and full CI runs are repeatably green;
- the deployed API and worker both report calendar configuration enabled and Redis connected;
- the corrected real-account checklist passes in both supported locales;
- revocation and reconnect are demonstrated end to end;
- dashboards/alerts show queued, oldest pending, failed, and reconnect-needed state;
- the sensitive-scope verification plan is accepted for the intended audience, or the product is explicitly limited to approved test users during a pilot.
