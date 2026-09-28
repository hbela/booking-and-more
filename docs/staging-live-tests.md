# Live staging booking and chat tests

The existing `e2e` tests use mocked API responses. The separate `e2e-live`
suite uses Chromium, the deployed frontend, and the real staging API and its
database. It does not intercept or replace API responses. No local server,
database connection string, owner password, or AI key is needed on the runner.

Targets are fixed in `playwright.live.config.ts` and `e2e-live/fixtures.ts`:

- Frontend: `https://app.booking.appointer.hu`
- API: `https://api.booking.appointer.hu`

## Prepare a dedicated tenant

Use a staging tenant reserved for automated checks, not a clinic with actual
patients. Configure it once through the usual onboarding and owner screens:

- An active Professional or Professional Plus entitlement and an enabled assistant.
- English available for the assistant and catalogue.
- A public service and assigned public provider with working hours and availability
  7 to 21 days ahead. The booking window must include those dates.
- Cancellation permitted at least a week before the appointment.
- A controlled customer email inbox; provider/owner notifications must also go to
  controlled test recipients. Booking and cancellation can trigger real emails.

The suite never creates subscriptions, activates tenants, changes schedules, or
overrides quotas. Setup failures are failures, not skipped or silently mocked tests.

## Run from PowerShell

From the repository root, set process-local variables (no secret environment file
changes):

```powershell
$env:STAGING_E2E_TENANT_SLUG = 'your-dedicated-test-tenant'
$env:STAGING_E2E_EMAIL = 'your-controlled-test-inbox@example.com'

# Optional: select particular resources within that tenant.
# Otherwise the first public service and its first public provider are used.
# $env:STAGING_E2E_SERVICE_ID = '...'
# $env:STAGING_E2E_PROVIDER_ID = '...'

# Read-only readiness check; creates no session or booking.
corepack pnpm --filter @bam/web test:e2e:live --grep preflight

# Explicitly enable writes for the full run.
$env:STAGING_E2E_ALLOW_MUTATIONS = '1'
corepack pnpm --filter @bam/web test:e2e:live

# Optional: watch the browser instead of running headlessly.
# corepack pnpm --filter @bam/web test:e2e:live --headed

Remove-Item Env:STAGING_E2E_ALLOW_MUTATIONS
```

To run only one flow, append `--grep 'booking:'` or `--grep 'chat:'`.
Use `--list` to discover the tests without contacting staging.

## What is checked

1. Readiness: the tenant resolves, public services exist, and the assistant is available.
2. Booking: the browser selects a service/provider/time and submits synthetic customer
   details. A new API read verifies the persisted booking. Repeating the confirmation
   with the same idempotency key returns the same reference and management credential.
   A random management credential is rejected. Cleanup cancels the booking, retries
   that cancellation idempotently, and reads back `CANCELLED`.
3. Chat: opening the page does not start a session. Clicking Start chat creates one;
   retrying its start returns the same session and fixed deadline. Wrong credentials
   are rejected. An oversized direct API message is refused without a new transcript
   entry or character consumption. One browser message uses the real configured AI
   provider. The suite checks the streamed completion and persisted transcript,
   repeats the same message request, and verifies no duplicate transcript entry or
   extra character consumption. Refresh restores that conversation.

These checks verify persistence through independent API reads. They do not inspect
database rows directly, owner dashboard visibility, token accounting, quota-counter
increments, notification delivery, or the number of provider calls. Exact AI wording
is not asserted. Race conditions and full quota boundaries belong in isolated backend
integration tests; this small suite checks the deployed path.

## Side effects and cleanup

Each successful full run creates one booking (then cancels it) and consumes one chat
allowance with one intended paid AI generation plus token counting. Idempotent retries
should not consume extra chats or generations; a regression can still cause extra
cost, so the suite does not retry failed tests automatically.

Booking cleanup runs in `finally`, including after assertions fail. If the browser
lost the confirmation response, cleanup replays its original idempotency key to recover
the management credential. Holds are released. Cancelled bookings, synthetic customer
records, audit records, and notifications remain as normal application history.

There is no public close-session endpoint. The synthetic chat expires normally after
the configured TTL and is processed by the existing cleanup worker. Its transcript and
usage remain; allowances are not refunded. The prompt only asks for services, and the
suite never confirms an AI booking action.

A killed process, unavailable API, or changed cancellation policy can prevent cleanup.
Inspect the dedicated tenant for appointments with customer names starting `E2E ` and
cancel them through the owner UI. Do not delete another tenant's data or reset usage.
Run only one copy against a tenant at a time, including local and CI runs.

Traces, screenshots and video are disabled because requests contain session and
management credentials. Do not enable network debug logging or upload storage state.
Assertions avoid printing raw credential values and response bodies.
Playwright can still save failure page context containing a management link; treat
`apps/web/test-results/live` as sensitive and do not publish it. The workflow does
not upload test artifacts.

## GitHub Actions

The `Staging live booking and chat` workflow is separate from pull-request CI and has
no automatic schedule. After committing/pushing it, configure these repository Actions
variables under **Settings > Secrets and variables > Actions > Variables**:

- `STAGING_E2E_TENANT_SLUG`
- `STAGING_E2E_EMAIL`
- Optionally `STAGING_E2E_SERVICE_ID` and `STAGING_E2E_PROVIDER_ID`

Run it from **Actions > Staging live booking and chat > Run workflow**, select the
branch whose tests match the deployed version, and enable the mutation checkbox.
GitHub requires a `workflow_dispatch` workflow to exist on the default branch before
the manual Run workflow control is available. Until then, use the local command.
Runs are serialized and an in-progress run is not cancelled by a new run.

Once the suite has passed against the dedicated tenant, the same command can become
a post-deployment check or a scheduled job. Keep its tenant isolated and account for
the daily/monthly chat allowance and AI cost when choosing the frequency.
