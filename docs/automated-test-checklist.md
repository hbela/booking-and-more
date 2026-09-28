# Automated staging follow-up

Status recorded 2026-09-28. Checked items were executed, not just implemented.
Manual release checks are outside this implementation task.

## 1. Owner dashboard and usage

- [x] [AUTO / staging] Public booking appears in the authenticated owner dashboard.
- [x] [AUTO / staging] Cancellation persists and appears under cancelled bookings.
- [x] [AUTO / staging] One chat start increases monthly usage by exactly one.
- [x] [AUTO / staging] Start/message retries and refresh do not consume another allowance.
- [x] [AUTO / staging] Real AI input/output token totals increase once and not on retry.
- [x] [AUTO / staging] Oversized input does not consume characters or tokens.

Evidence: all three extended `test:e2e:live` scenarios passed locally against staging.

## 2. Stripe

- [x] [AUTO / isolated database] Billing access and webhook lifecycle regressions: 47 worker
      Stripe tests passed; billing API tests passed in the 99-test API run below.
- [x] [AUTO / isolated database] Duplicate/reordered events, grandfathered plan recognition,
      scheduled changes, and subscription entitlement guards.
- [x] [AUTO / staging] Real Payment Links for Form, Professional, Professional Plus.
- [x] [AUTO / staging] Activation and entitlements for Form, Professional, Professional Plus,
      and legacy Form; cancellation verified for completed scenarios.
- [x] [AUTO / staging] Legacy Professional activation and entitlements.
- [x] [AUTO / staging] Prorated upgrades, clock-driven renewal downgrade, failed renewal,
      and cancellation with cleanup of disposable Sandbox subscriptions.

Evidence: all five `test:e2e:stripe` scenarios passed against staging revision `8633c0d`
in 2.2 minutes. The [webhook reconciliation fix](stripe-webhook-reconciliation.md)
resolved the same-second schedule-ordering defect without weakening the assertion.
All five also passed in [GitHub Actions](https://github.com/hbela/booking-and-more/actions/runs/36485174139).
Hosted Stripe Checkout completion is a **[MANUAL]** release check, per Stripe's automation
guidance; Payment Link creation plus test-API subscriptions do not claim to cover it.

## 3. AI and concurrency protections

- [x] [AUTO / isolated database] Slot conflicts and cross-tenant booking access.
- [x] [AUTO / isolated database] Concurrent chat admissions, start/message idempotency,
      daily quota, UTC bucket resets and plan changes without usage resets.
- [x] [AUTO / isolated database] Unicode boundaries, per-chat token/turn/character limits.
- [x] [AUTO / isolated database] Expiry blocks confirmation, persists one goodbye, releases
      holds, preserves transcript and rejects late AI results while accounting for usage.
- [x] [AUTO / isolated database] Token-count failure blocks generation; uncertain generation
      failures retain their reservation; prompt injection cannot bypass explicit confirmation.
- [x] [AUTO / provider unit] Complete request counting, output cap, timeout and no-retry options.

Evidence: `conversation.test.ts`, `usage.test.ts`, `booking.test.ts`, `billing.test.ts`:
99 tests passed against the local test database. `@bam/ai`: 16 tests passed.
These are already included in pull-request CI; destructive boundary tests do not run
against shared staging.

## 4. Automated execution

- [x] [AUTO] Owner login and in-memory session teardown implemented and exercised.
- [x] [AUTO] Verify real Stripe suite before enabling its CI path.
- [x] [AUTO] Configure repository Actions variables and encrypted owner-password secret.
- [x] [AUTO] Validate and store the encrypted Stripe Sandbox secret.
- [x] [AUTO] Publish updated workflow and test code; verify an Actions run.
      [Booking/chat run](https://github.com/hbela/booking-and-more/actions/runs/36485170614):
      all three scenarios passed against staging.
- [x] [AUTO] Make the workflow available on the default branch and enable weekly booking/chat.
      Enabled Wednesdays at 05:30 UTC, testing `release/production-launch-2026-09-20`.
- [ ] [AUTO] Confirm the first scheduled run. Scheduling alone is not evidence of execution.
      First expected run: Wednesday, 2026-09-30 at 05:30 UTC.

Commands and cleanup behavior: [staging-live-tests.md](staging-live-tests.md).

## Fixes and remaining follow-ups

- [x] [AUTO] Fix same-second Stripe event ordering, add regression coverage, deploy to
      staging, and rerun the complete lifecycle suite. Do not add sleeps to hide this race.
- [x] [AUTO] Retry legacy Professional after the tenant-creation rate limit resets.
- [x] [AUTO] Resolve the existing high/critical dependency-audit failures on `main`
      and merge [the workflow registration PR](https://github.com/hbela/booking-and-more/pull/1).
      Its patched web package passed lint, type-check and 329 tests locally.
- [x] [AUTO / maintenance] Fix pre-existing formatting debt on `main` and resolve the
      four remaining moderate audit findings. Both full and production dependency audits
      report no known vulnerabilities. Merged [maintenance PR](https://github.com/hbela/booking-and-more/pull/2).
      [Full CI](https://github.com/hbela/booking-and-more/actions/runs/36492464387) passed
      formatting, audit, lint, type-check, tests, build, browser smoke tests and fresh-database
      migrations. Also corrected test fixtures and an outbox claim that could exceed its batch limit.
