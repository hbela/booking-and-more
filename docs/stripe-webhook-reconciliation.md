# Stripe webhook reconciliation

Implemented in `8633c0d` and deployed to staging on 2026-09-28.

The live Sandbox suite reproduced a lost scheduled downgrade: Stripe created and
updated a schedule in the same second, and the worker treated the update's lower
event ID as stale. IDs cannot order these snapshots. Stripe also does not guarantee
[webhook delivery order](https://docs.stripe.com/webhooks#event-ordering).

The configured worker now retrieves the current Stripe subscription or schedule
for lifecycle events. It applies the current status, including terminal states,
instead of trusting the incoming snapshot. It verifies object identity, billing
mode and schedule ownership before applying the result.

The worker reads both subscription and schedule event markers before the Stripe
request. The database update compares both markers atomically. A competing change
causes a retry with a fresh Stripe read. No database transaction remains open during
the provider call. Reads have a 30-second timeout and no automatic SDK retries;
the existing durable event queue retries failures on its next poll.

This adds a Stripe availability dependency to lifecycle reconciliation: a failed
read leaves the event unprocessed and access unchanged until retry succeeds. An
unconfigured worker can still apply unambiguous snapshots; same-second conflicts
remain queued instead of being ordered by ID.

Schedule phases use Stripe's current-phase start to identify future phases. This
also works when a Sandbox test clock is ahead of the worker's wall clock.

Regression coverage includes both delivery orders for same-second schedule events,
delayed release/deletion snapshots, simulated future phases, provider failure and a
competing database write. All 47 Stripe database tests pass; the complete worker
suite passed 162 tests with 15 unrelated tests skipped. Full release CI, including
AMD64 and ARM64 Linux image checks, passed before deployment.

The pre-deployment staging backup succeeded. Coolify deployed the exact commit;
API readiness, web health and all application container health checks passed.
Production resources and secret environment files were not changed.

Live verification passed locally (all five Stripe scenarios), then in GitHub Actions:

- [Stripe lifecycle: five passed](https://github.com/hbela/booking-and-more/actions/runs/36485174139).
- [Booking/chat: three passed](https://github.com/hbela/booking-and-more/actions/runs/36485170614).

The weekly booking/chat schedule is enabled for Wednesdays at 05:30 UTC. The first
actual scheduled execution remains a follow-up. Hosted Checkout completion remains
a manual release check.
