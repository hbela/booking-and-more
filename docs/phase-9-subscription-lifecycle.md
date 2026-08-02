This is the execution record for the fifth slice of Epic 9, derived from
[docs/guides/COMPLETE-STRIPE-SUBSCRIPTION.md](guides/COMPLETE-STRIPE-SUBSCRIPTION.md) and closing open
question 3 of [phase-9-subscription-and-activation.md](phase-9-subscription-and-activation.md).

# Phase 9 — Subscription lifecycle

## Implementation Record

**Document version:** 1.0 — built 2026-08-01, automated tests green, **§7 not yet walked against Stripe**.
**Scope:** everything between starting a subscription and cancelling one — a 30-day trial, plan changes,
scheduled downgrades, failed payments, and the entitlement rule that turns all of it into access.
**Depends on:** [phase-9-subscription-and-activation.md](phase-9-subscription-and-activation.md) for the
Payment Link and the event processor this extends, and
[phase-9-customer-portal.md](phase-9-customer-portal.md) for the portal that performs most of these changes.
**Exit criteria:** A new organization gets 30 free days with a card on file and no charge · The trial cannot
be taken twice · An upgrade applies at once and a downgrade at renewal, both visible on the screen · A
failed payment neither locks anybody out immediately nor forever · Events arriving out of order or twice
produce the same result

---

# 1. Context

Epic 9 delivered the two ends of a subscription and nothing in between. An owner can start one — an emailed
Payment Link, `checkout.session.completed`, tenant `ACTIVE` — and can manage one through the portal. The
lifecycle was missing entirely: no trial, `TenantStatus.TRIAL` reserved but unreachable, a failed payment
that did nothing, a scheduled downgrade that was invisible, and a processor acting on three event types out
of the nine the guide lists.

The policy implemented here is the guide's, stated once so the rest of the document can refer to it:

| Action                     | Takes effect          | Billing                  | Access             |
| -------------------------- | --------------------- | ------------------------ | ------------------ |
| Cancel during trial        | End of trial          | No charge                | Until trial ends   |
| Cancel a paid subscription | End of current period | No refund                | Until period ends  |
| Starter → Professional     | Immediately           | Prorated difference now  | Immediately        |
| Professional → Starter     | Next period           | No refund or credit now  | Professional until |
| Immediate cancellation     | Immediately           | Optional prorated refund | Revoked at once    |

"End of the month" means the end of the **customer's billing period**, never the last calendar day.

The last row is deliberately not built. §5 of the guide recommends doing exceptional refunds through the
Stripe Dashboard for phase one, and that advice is taken: no API, no `REFUND_PENDING` state, no proration
arithmetic of our own. Building financial edge cases before they exist is how they get built wrong.

---

# 2. Where this departs from the guide, and why

## 2.1 The trial starts from a Payment Link, not Checkout

The guide's §1 assumes `stripe.checkout.sessions.create` with `subscription_data.trial_period_days`. This
project cannot use it, and the reason is already on the record:
[phase-9-subscription-and-activation.md](phase-9-subscription-and-activation.md) §1.2 **amended** the epic
record's §5.1 from Checkout to a Payment Link, because a Checkout Session expires within 24 hours while the
subscribe window is `ONBOARDING_WINDOW_DAYS` (14). An emailed Checkout URL is dead for thirteen of the
fourteen days it exists to cover.

Payment Links support trials perfectly well: configure "Include a free trial" on the link and **do not**
tick "let customers start trial without payment method", and the card is collected upfront with nothing
charged — which is exactly what the guide's `payment_method_collection: "always"` achieves.

**What a Payment Link cannot do is vary the trial per customer.** The trial is a property of the link. So
the guide's trial-abuse protection — skip `trial_period_days` when `trialUsedAt` is set — becomes **two
links per plan**: one with the trial, one without. The server picks. That costs two environment variables
and two more links created once in the dashboard, and it keeps everything §1.2 bought.

## 2.2 Two windows, in sequence

There are now two clocks, and conflating them would be easy:

```
provisioned ──► PENDING_SUBSCRIPTION ──► TRIAL ──► ACTIVE
                 ≤ 14 days                30 days
                 to start the trial       free, card on file
                 (tenant.subscribeBy)     (subscription.trialEndsAt)
```

They answer different questions — *did the prospect ever engage* and *did the trial convert* — so they are
different fields on different rows and neither is derived from the other. `Tenant` is unchanged by this
slice.

## 2.3 Stripe's dunning is the grace period

The guide's §7 asks for "three to seven days" of access after `past_due` before revoking. Stripe already
does this: Smart Retries retries a failed renewal for a configured window and then cancels, which fires
`customer.subscription.deleted`, which suspends the tenant through code written in the previous slice.

So the grace period is a dashboard setting, not a column and not a sweep. Our entitlement rule stays one
line — **`past_due` keeps access, `deleted` revokes it** — and the length of the grace is tuned by whoever
is watching churn, without a deploy. The alternative was a `pastDueSince` column and a scheduled sweep the
project does not otherwise have.

The cost, stated: if somebody sets Smart Retries to retry for a month, a delinquent customer keeps access
for a month. That is a real exposure and it lives in the dashboard, which is why it is in §6's checklist
rather than left to a default.

## 2.4 Plan resolution stops depending on metadata

[phase-9-customer-portal.md](phase-9-customer-portal.md) §3.2 flagged `metadata[plan]` on both prices as a
load-bearing Stripe setup step. Scheduled downgrades make that untenable: a subscription **schedule** phase
carries `items[0].price` as a bare price-ID string with no metadata on it at all, so there is nothing to
read.

Plan is therefore resolved from the **price ID**, mapped through config (`STRIPE_PRICE_STARTER`,
`STRIPE_PRICE_PROFESSIONAL`), with metadata kept as a fallback so nothing already working breaks. The
mapping is a pure function in `@bam/contracts` next to `daysUntil`, and config validation requires the price
IDs whenever `STRIPE_SECRET_KEY` is set — turning a silent misconfiguration into a boot failure.

---

# 3. The entitlement rule

One pure function, one table, unit-tested exhaustively. This is the whole of "what does Stripe's state mean
for access", and it exists in one place so it cannot drift between the three call sites that used to
each decide a piece of it.

| Stripe status        | `Subscription.status` | Tenant                             |
| -------------------- | --------------------- | ---------------------------------- |
| `trialing`           | `TRIALING`            | `TRIAL`                            |
| `active`             | `ACTIVE`              | `ACTIVE`                           |
| `past_due`           | `PAST_DUE`            | unchanged — dunning is the grace   |
| `unpaid`             | `PAST_DUE`            | `SUSPENDED`                        |
| `canceled`           | `CANCELED`            | `SUSPENDED`                        |
| `incomplete`         | `INCOMPLETE`          | unchanged — nothing granted or revoked |
| `incomplete_expired` | `INCOMPLETE`          | `SUSPENDED`                        |
| `paused`             | `PAST_DUE`            | `SUSPENDED`                        |

Two rules constrain every row and are worth stating separately, because they are what stops this table
being edited carelessly later:

**A Stripe event never lifts a tenant out of `SUSPENDED`.** Argued in customer-portal §3.3 and unchanged:
`SUSPENDED` has two causes — Stripe cancelled, or a platform admin intervened — and the row does not record
which. Reactivating on a Stripe event would silently reverse an operator's suspension of an organization
under investigation. Recovery is deliberate and stays with the platform admin.

**An unrecognised status still throws.** phase-9 §2.7 refused the predecessor's free-text status column, and
that decision holds: a value nobody has considered must be loud, not stored.

---

# 4. Out-of-order delivery

The guide's testing checklist asks for "webhooks arrive in an unexpected order" (#15) and this integration
genuinely failed it.

`customer.subscription.created` carries **no `client_reference_id`** — that field belongs to the checkout
session. So the only way to attribute it to a tenant is `stripeSubscriptionId`, which is written by
`checkout.session.completed`. If the subscription event lands first, the lookup finds nothing, and the
previous implementation logged a warning and dropped it.

The fix is neither to ignore nor to fail forever:

> **An unattributable subscription event throws while it is younger than `STRIPE_EVENT_ORPHAN_TIMEOUT_MS`
> (default 15 minutes), so it retries on the next poll. Past that, it is marked processed with a warning.**

The sibling event arrives within seconds in practice, so this self-heals on the first retry. The timeout is
what stops a genuinely foreign subscription — someone else's, or one created directly in the dashboard —
retrying until the end of time and filling `stripe_events` with permanent failures.

This works because the poller already retries anything left unprocessed and records `lastError`; the
mechanism was there, only the decision was wrong.

---

# 5. Data model

One migration. All of it on `Subscription`; `Tenant` is untouched (§2.2).

| Column                    | Why                                                                     |
| ------------------------- | ----------------------------------------------------------------------- |
| `stripe_price_id`         | What was actually bought. Makes a wrong plan diagnosable without Stripe |
| `trial_ends_at`           | The screen's countdown, and the authoritative trial end                 |
| `trial_used_at`           | The trial-once gate. Set once, never overwritten                        |
| `stripe_schedule_id`      | A scheduled downgrade's schedule, so it can be recognised and cleared   |
| `pending_plan`            | What the plan becomes at renewal                                        |
| `pending_plan_starts_at`  | When                                                                    |

`trial_used_at` lives here rather than on `Tenant` because the subscription row is 1:1 with the tenant and
**survives cancellation** — `customer.subscription.deleted` sets the status to `CANCELED` and keeps the row.
That is precisely the case it exists to answer: an owner who cancels and resubscribes must not receive
another thirty free days. On `Tenant` it would have been equally correct and less obviously connected to the
thing it constrains.

---

# 6. Stripe configuration

**This integration is half configuration.** None of the below is optional, and none of it is visible in the
repository, which is why it is a checklist rather than a paragraph.

### ~~Payment Links — four, created once~~ — **superseded 2026-08-02**

> Replaced by [phase-9-duplicate-subscription-prevention.md](phase-9-duplicate-subscription-prevention.md)
> §4. **There are no Payment Links to create in the dashboard any more**, and the four
> `STRIPE_PAYMENT_LINK_*` variables below no longer exist. A link is created per organization at subscribe
> time, carrying `restrictions[completed_sessions][limit]=1` and `subscription_data[trial_period_days]`.
>
> This section is kept rather than deleted because it records *why* there were four: §2.1 below is still the
> right explanation of the trial-once rule, and only its mechanism changed. The reason the links had to go is
> that a link created once per plan is permanent, reusable and shared by every customer — so one organization
> could pay twice and did.

| Link                                       | Trial     | Card |
| ------------------------------------------ | --------- | ---- |
| `STRIPE_PAYMENT_LINK_STARTER`              | 30 days   | yes  |
| `STRIPE_PAYMENT_LINK_STARTER_NO_TRIAL`     | none      | yes  |
| `STRIPE_PAYMENT_LINK_PROFESSIONAL`         | 30 days   | yes  |
| `STRIPE_PAYMENT_LINK_PROFESSIONAL_NO_TRIAL`| none      | yes  |

Each must accept `client_reference_id` — without it a completed payment cannot be attributed (§3.2 of the
subscription record). On the trial links, **do not** tick "let customers start trial without payment
method": the card upfront is the whole point, and without it the trial ends in a pause rather than a sale.
That last constraint survives the change: a link created in code sets `trial_period_days` and nothing else,
so Checkout collects the card by default.

### Prices

`metadata[plan]` set to `STARTER` / `PROFESSIONAL` on both, and their IDs in `STRIPE_PRICE_STARTER` /
`STRIPE_PRICE_PROFESSIONAL`. The env vars are now authoritative and the metadata is the fallback (§2.4).

### Customer portal — Settings → Billing → Customer portal

- Cancellation: **enabled**, **at end of billing period**, reasons enabled.
- Plan switching: **enabled**, `default_allowed_updates: ["price"]`.
- Proration: `always_invoice` — upgrades bill the difference at once.
- Billing cycle anchor: `unchanged`.
- `schedule_at_period_end` on condition `decreasing_item_amount` — this is what makes a downgrade a
  scheduled one rather than an immediate refund-shaped mess.
- `trial_update_behavior: "continue_trial"` — **without this a plan switch during the trial ends the trial
  and bills immediately.** Requires API ≥ `2025-09-30.clover`; `stripe.client.ts` pins `2026-07-29.dahlia`.

`ensurePortalConfig()` stays refused, per customer-portal §2.1: a billing policy created by code is one
nobody reviewed.

### Smart Retries — Settings → Billing → Automatic collection

Retries exhausted after roughly a week, then **cancel the subscription**. This is the grace period (§2.3).

---

# 7. What was built

| Piece                                                        | Where                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------- |
| `planForPrice`, `subscriptionEffect`, `nextTenantStatus`     | `packages/contracts/src/billing.ts` — pure, 20 tests    |
| Two links per plan, price IDs, trial length, orphan timeout  | `packages/config/src/schema.ts` — three new `superRefine`s |
| `trialEndsAt`, `trialUsedAt`, `stripePriceId`, schedule cols | migration `…_subscription_lifecycle`                    |
| Trial vs no-trial link selection                             | `billing.service.ts` `requestPaymentLink`               |
| `trialAvailable`, `pendingPlan`, `trialEndsAt` on the wire   | `billing.routes.ts`                                     |
| Every lifecycle event, schedules, orphan retry               | `apps/worker/src/stripe/stripe.processor.ts`            |
| `TRIAL_ENDING_SOON`, `SUBSCRIPTION_PAYMENT_FAILED`           | notification-engine + `outbox.dispatcher.ts` `dispatchBillingNotice` |
| Trial, downgrade and past-due states                         | `subscription-screen.tsx`, en + hu                      |
| 20 new tests                                                 | `billing.test.ts` (contracts), `stripe.processor.test.ts`, `billing.test.ts` (api) |

## 7.1 A bug the tests found, which the plan had missed

The plan said "a Stripe event never lifts a tenant out of `SUSPENDED`" and the processor did not implement
it. `subscriptionEffect("active")` returns `tenantStatus: "ACTIVE"`, and `mirrorSubscription` applied that
unconditionally — so **any** subscription event reporting `active` would have reactivated an organization a
platform admin had suspended, including a redelivery of an event from before the suspension.

The refusal is now its own pure function, `nextTenantStatus(current, effect)`, rather than a condition
inside the mapping table. That separation is the point: a mapping table invites new rows, and a refusal
buried in one gets edited away by somebody adding one. Written while writing the test that asserted it —
which is the only reason it was found before a customer was.

## 7.2 Two smaller things worth knowing

- **`checkout.session.completed` no longer decides the tenant's status.** A trial checkout and a paid one
  produce an identical session object, and the session does not carry the subscription's status — so it
  cannot tell `TRIAL` from `ACTIVE`. It now binds identifiers and clears `subscribeBy`, and the
  `customer.subscription.*` events decide, which is also what makes §4's retry able to attribute them.
- **The §8.2 test trap caught this suite again.** `stripe_subscription_id` is unique across the whole
  table, and a `beforeEach` shared one literal across three schedule tests, so the second collided with the
  row the first left. Every Stripe id in the new tests is regenerated per test, not per run.

---

# 8. Verification

**Not yet performed.** This is the procedure, not a record of having run it. What is verified today is the
automated suite — 20 new tests covering the entitlement table row by row, the trial-once gate from both
sides, orphan retry and its timeout, schedules being set and cleared three different ways, and `past_due`
leaving access alone while `deleted` revokes it. What they cannot cover is Stripe actually behaving as
documented, which is what the steps below are for.

Continues §6 of the subscription record. **Read its §6.1 first** — both ways a webhook silently does nothing
apply here unchanged and cost an afternoon each.

Use a **test clock** for everything time-dependent; none of steps 2, 3, 6 or 9 is reachable otherwise.

1. Provision → accept → subscribe. Expect the trial link, tenant `TRIAL`, full navigation, no charge.
2. Advance 27 days → `trial_will_end` → `TRIAL_ENDING` in the worker log.
3. Advance past 30 → first charge succeeds → tenant `ACTIVE`.
4. Portal: Starter → Professional. Expect an immediate prorated invoice, plan mirrored at once.
5. Portal: Professional → Starter. Expect "Professional until <date>, then Starter" while Stripe still
   bills Professional.
6. Advance to renewal → the downgrade lands, `pendingPlan` clears.
7. Portal: cancel → "Ends on <date>"; reverse it → "Renews on <date>".
8. Cancel and run it out → `SUSPENDED`. Resubscribe: expect the **no-trial** link. Check whether Stripe
   reused the customer — see §8.
9. Fail a renewal with `4000 0000 0000 0341`. Expect `PAST_DUE`, access retained, `PAYMENT_FAILED` sent;
   let dunning expire → `SUSPENDED`.
10. `stripe events resend` two events out of order, and one twice. Neither changes the outcome.

`pnpm db:discard-organization <domain> --yes` between runs.

---

# 9. Known risk

A Payment Link may create a **second Stripe Customer** for a resubscribing owner rather than reusing the
first. The portal session is built from `stripeCustomerId`, so a stale one would point at a customer with no
live subscription.

Mitigated rather than solved: `prefilled_email` matches an existing customer in most cases, and the
processor overwrites `stripeCustomerId` from every completion event, so our row follows the live
subscription even when Stripe makes a new customer. Step 8 above checks it explicitly rather than assuming.

---

# 10. Open questions

1. **Quotas still read nothing.** `plan` is now correct and current through every path, which was the
   precondition for tech-impl §37's per-plan limits. Nothing enforces them yet — that is step 11 of the
   epic record and the original Epic 9.
2. **The expiry sweep is still unbuilt**, so `subscribeBy` passing does nothing and a prospect who never
   starts a trial is never closed. Unaffected by this slice, but now the only remaining timer.
3. **Immediate cancellation with a refund** stays a Dashboard action (§1). Revisit when support actually
   needs it more than a few times.
