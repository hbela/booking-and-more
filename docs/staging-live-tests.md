# Live staging booking and chat tests

The existing `e2e` tests use mocked API responses. The separate `e2e-live`
suite uses Chromium, the deployed frontend, and the real staging API and its
database. It does not intercept or replace API responses. No local server,
database connection string or AI key is needed on the runner. Owner checks require
a normal test-owner login; the separate Stripe suite also needs a Sandbox key.

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

The booking/chat suite never changes subscriptions or schedules, or overrides quotas.
The separate Stripe suite creates disposable organizations and Sandbox subscriptions.
Setup failures are failures, not skipped or silently mocked tests.

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

Set `STAGING_E2E_OWNER_EMAIL` and `STAGING_E2E_OWNER_PASSWORD` in your ignored
`.env.staging-tests` or existing `.env`. Only `STAGING_E2E_*` keys are loaded; process
variables take precedence, followed by `.env.staging-tests`, then `.env`. Do not commit
these files. Owner cookies stay in memory and the test session is signed out afterward.

## What is checked

1. Readiness: the tenant resolves, public services exist, and the assistant is available.
2. Booking: the browser selects a service/provider/time and submits synthetic customer
   details. A new API read verifies the persisted booking. Repeating the confirmation
   with the same idempotency key returns the same reference and management credential.
   A random management credential is rejected. Cleanup cancels the booking, retries
   that cancellation idempotently, and reads back `CANCELLED`. A separate authenticated
   browser verifies both the new appointment and its cancellation in the owner dashboard.
3. Chat: opening the page does not start a session. Clicking Start chat creates one;
   retrying its start returns the same session and fixed deadline. Wrong credentials
   are rejected. An oversized direct API message is refused without a new transcript
   entry or character consumption. One browser message uses the real configured AI
   provider. The suite checks the streamed completion and persisted transcript,
   repeats the same message request, and verifies no duplicate transcript entry or
   extra character consumption. Refresh restores that conversation. The owner's monthly
   usage increases by exactly one and stays unchanged on retries and refresh. Input and
   output token totals increase after the real reply, but not after rejected input or retries.

These checks verify persistence through independent API reads. They do not inspect
database rows directly, notification delivery, or the provider's own billing ledger.
Exact AI wording is not asserted. Run without other traffic on the test tenant so usage
deltas are unambiguous. Daily/monthly boundaries, concurrent admissions, exact fake-provider
call counts, and failure injection run in isolated backend integration tests.

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

## Stripe Sandbox lifecycle

Set `STAGING_E2E_STRIPE_SECRET_KEY` to a test key from Peach Seesaw Sandbox in the same
ignored file, then run:

```powershell
corepack pnpm --filter @bam/web test:e2e:stripe
```

This separate suite verifies the exact Sandbox account and rejects live keys. It creates
an `e2e-billing-*` organization per catalogue case, verifies the app creates a real Payment
Link for each current plan, and creates subscriptions through Stripe's test API with the
same tenant metadata. Real webhook delivery and worker processing must update the app's
subscription and entitlements. It covers all three paid plans, both legacy prices, immediate
prorated upgrades, a scheduled downgrade advanced with a test clock, a declined renewal,
and cancellation. It does not change the existing `wellness` subscription.

Cleanup deactivates new links, cancels new subscriptions, deletes each test clock, and
restores the owner's original active test tenant. Synthetic organizations and billing
history remain for diagnosis. Test emails/invoices can be generated. A killed runner may
require cleanup of resources tagged with its `e2e-billing-*` name in the Sandbox dashboard.

A complete run creates five organizations, matching the API's five-per-hour creation
limit. Repeated local runs can return HTTP 429; wait for the limit to reset rather than
disabling it. Current failures and follow-ups are recorded in
[the automated test checklist](automated-test-checklist.md).

Stripe's hosted Checkout UI is **not** automated: Stripe documents security measures that
prevent automated UI testing. Completing that hosted form remains a manual release check.
See [Stripe automated testing](https://docs.stripe.com/automated-testing) and
[test clocks](https://docs.stripe.com/billing/testing/test-clocks).

## GitHub Actions

The `Staging live tests` workflow is separate from pull-request CI. Configure these Actions
variables under **Settings > Secrets and variables > Actions > Variables**:

- `STAGING_E2E_TENANT_SLUG`
- `STAGING_E2E_EMAIL`
- `STAGING_E2E_OWNER_EMAIL`
- `STAGING_E2E_SCHEDULE_ENABLED=true` to opt into weekly booking/chat checks
- `STAGING_E2E_REF` naming the branch or commit to test on scheduled runs
- Optionally `STAGING_E2E_SERVICE_ID` and `STAGING_E2E_PROVIDER_ID`

Add `STAGING_E2E_OWNER_PASSWORD` and `STAGING_E2E_STRIPE_SECRET_KEY` as Actions **secrets**.
The Stripe secret is passed only to the Stripe step. Scheduled runs only execute
booking/chat; Stripe lifecycle checks are manually triggered automation.

Run it from **Actions > Staging live tests > Run workflow**, select the
branch whose tests match the deployed version, choose the suite, and enable the mutation checkbox.
GitHub requires a `workflow_dispatch` workflow to exist on the default branch before
the manual Run workflow control is available. Until then, use the local command.
Runs are serialized and an in-progress run is not cancelled by a new run.

Weekly runs are Wednesdays at 05:30 UTC. Both the workflow on the default branch and
the schedule-enabled variable are required for scheduling to take effect. Keep the tenant
isolated and account for the monthly allowance (normally 4–5 scheduled chats per month).
