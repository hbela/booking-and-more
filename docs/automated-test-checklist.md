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

- [x] [AUTO / isolated database] Billing access and webhook lifecycle regressions: 40 worker
      Stripe tests passed; billing API tests passed in the 99-test API run below.
- [x] [AUTO / isolated database] Duplicate/reordered events, grandfathered plan recognition,
      scheduled changes, and subscription entitlement guards.
- [x] [AUTO / staging] Real Payment Links for Form, Professional, Professional Plus.
- [x] [AUTO / staging] Activation and entitlements for Form, Professional, Professional Plus,
      and legacy Form; cancellation verified for completed scenarios.
- [ ] [AUTO / staging] Legacy Professional activation and entitlements: retry after the
      five-tenant-creations-per-hour rate limit resets (HTTP 429 after repeated runs).
- [ ] [AUTO / staging] Prorated upgrades, clock-driven renewal downgrade, failed renewal,
      and cancellation with cleanup of disposable Sandbox subscriptions.

Implementation: `test:e2e:stripe`. The corrected key was verified against Peach Seesaw
Sandbox and stored in GitHub Actions. Live execution exposed a schedule-ordering defect:
same-second `subscription_schedule.created` and `subscription_schedule.updated` events
can leave `pendingPlan` null because the worker orders equal timestamps by event ID.
The failing assertion remains enabled; the full lifecycle suite is not green.
The independent Professional, Professional Plus, and legacy Form scenarios passed.
Form activation and immediate prorated upgrades passed before the lifecycle failure.
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
- [ ] [AUTO] Verify real Stripe suite before enabling its CI path.
- [x] [AUTO] Configure repository Actions variables and encrypted owner-password secret.
- [x] [AUTO] Validate and store the encrypted Stripe Sandbox secret.
- [ ] [AUTO] Publish updated workflow and test code; verify an Actions run.
- [ ] [AUTO] Make the workflow available on the default branch and enable weekly booking/chat.
- [ ] [AUTO] Confirm the first scheduled run. Scheduling alone is not evidence of execution.

Commands and cleanup behavior: [staging-live-tests.md](staging-live-tests.md).

## Follow-up blockers

- [ ] [AUTO] Fix same-second Stripe event ordering, add regression coverage, deploy to
      staging, and rerun the complete lifecycle suite. Do not add sleeps to hide this race.
- [ ] [AUTO] Retry legacy Professional after the tenant-creation rate limit resets.
- [ ] [AUTO] Resolve the existing dependency-audit failures on `main` before merging
      [the workflow-only PR](https://github.com/hbela/booking-and-more/pull/1).
      Its CI run reports 10 high and 2 critical findings in the existing dependencies.
      Scheduling remains disabled.
