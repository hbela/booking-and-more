This is the plan for the sixth slice of Epic 9, opened by a production-shaped incident on 2026-08-02 and
amending [phase-9-subscription-and-activation.md](phase-9-subscription-and-activation.md) §1.2 and
[phase-9-subscription-lifecycle.md](phase-9-subscription-lifecycle.md) §2.1.

# Phase 9 — Duplicate subscription prevention

## Implementation Record

**Document version:** 1.0 — built 2026-08-02, automated tests green, **§6's manual half not yet walked
against Stripe**. §5.3 (the reconciliation sweep) and §7 (cleaning up the existing incident) are the two
things deliberately not done; everything else in this document is code.
**Scope:** making it structurally impossible for one organization to hold two live Stripe subscriptions.
**Depends on:** [phase-9-subscription-and-activation.md](phase-9-subscription-and-activation.md) for the
Payment Link and the event processor, [phase-9-subscription-lifecycle.md](phase-9-subscription-lifecycle.md)
for the trial and the entitlement rule.
**Exit criteria:** A second checkout for an organization that already has one is refused by Stripe, not by
us · A webhook outage of any length cannot widen the window · A duplicate that happens anyway is loud within
minutes · No customer is ever charged twice for one month without somebody being told

---

# 1. The incident

One tenant ended up holding **three live Stripe subscriptions**. Nothing in the system noticed; it was found
by opening the Stripe dashboard.

The guard that was supposed to prevent this is `BillingService.requestPaymentLink`
([billing.service.ts:180](../apps/api/src/modules/billing/billing.service.ts#L180)):

```ts
const existing = await this.currentSubscription(input.tenantId);

if (isLiveSubscription(existing?.status)) {
  throw new ConflictError(/* … */ "This organization already has a subscription.");
}
```

It reads the local `subscriptions` row. That row is written by `activate()` in the worker, which runs only
after `checkout.session.completed` has been delivered, recorded and polled. **The guard depends on the
completion of the very path it exists to protect.** Until the webhook lands, the guard reads `null` and
waves everything through.

This was found in local development, where no webhook forwarding was running and the window was therefore
infinite. It is not a local-dev artifact. In production the same window is opened by any Stripe delivery
delay, any webhook outage, any worker that is down or backed up — and there the duplicates bill real money.

---

# 2. Three defects, not one

## 2.1 The guard reads a replica of the authority (the reported gap)

Stated above. Worth adding: the window is **wider than "until the webhook lands"**, because of what
`activate()` writes.

`activate()` creates the row with `status: "INCOMPLETE"` — deliberately, since a checkout session cannot
distinguish a trial from a paid subscription and only `customer.subscription.*` can (§3.2 of the activation
record). But `isLiveSubscription("INCOMPLETE")` is **false**
([billing.ts:126](../packages/contracts/src/billing.ts#L126), asserted at
[billing.test.ts:126](../packages/contracts/src/billing.test.ts#L126)).

So the guard stays open not until `checkout.session.completed` is processed, but until
`customer.subscription.created` is *also* processed and sets `TRIALING` or `ACTIVE`. Two events, two poll
intervals, and — per §4 of the lifecycle record — an ordering race between them that is explicitly expected
to need retries.

## 2.2 No local guard can cover the payment path at all

This is the more serious one, and it is why "fix the guard" is not the answer.

A Payment Link is a **permanent, reusable URL**, by design — activation record §1.2 chose it over a Checkout
Session precisely because it does not expire inside the 14-day subscribe window. It is also **shared by
every customer on that plan**, which is why `client_reference_id` has to carry the tenant.

Consequences:

- The owner has the link in their inbox forever. They can open it again next week and check out again.
- Our API is not on the path between their browser and Stripe's hosted page. `POST /v1/billing/subscribe`
  is a *link vending machine*, not a checkout gate. Refusing to vend a second link does nothing about the
  first one, which still works.
- Therefore **every purely local guard is decorative**, however consistent its data. The guard could read a
  perfectly fresh source and the second payment would still go through.

The constraint has to live in the only system that is on the payment path: Stripe.

## 2.3 A duplicate overwrites the first silently

`activate()` upserts on `tenantId`:

```ts
await tx.subscription.upsert({
  where: { tenantId },
  create: { tenantId, plan, status: "INCOMPLETE", ...identifiers },
  update: identifiers,          // ← overwrites stripeSubscriptionId
});
```

When the second checkout completes, `stripeSubscriptionId` is replaced with `sub_2`. The first subscription
is then **invisible to us and unstoppable by us**: subsequent `customer.subscription.updated` events for
`sub_1` reach `findByStripeId`, find nothing, throw `OrphanEventError`, retry until
`STRIPE_EVENT_ORPHAN_TIMEOUT_MS` (15 min default) and are then marked processed with a `warn`. It bills
monthly, forever, and no row in our database points at it.

The `@unique` on `tenantId` — described in the schema as "load-bearing … what stops a redelivered Stripe
webhook creating a second subscription for one payment" — does exactly what it says and nothing more. It
stops *two rows*. It does not stop *two subscriptions*; it guarantees we can only see one of them.

This is the defect that turned "a duplicate happened" into "a duplicate happened three times and nobody
knew".

---

# 3. What does not work, and why

Recording these so they are not re-proposed.

## 3.1 Search Stripe in the guard — has the same bug

The obvious fix is to make the guard authoritative by asking Stripe instead of the local table:

```ts
stripe.subscriptions.search({ query: `metadata['tenantId']:'${tenantId}' AND status:'active'` });
```

The Stripe API reference for `GET /v1/subscriptions/search` says, verbatim:

> Don't use search in read-after-write flows where strict consistency is necessary. Under normal operating
> conditions, data is searchable in less than a minute. Occasionally, propagation of new or updated data can
> be up to an hour behind **during outages**.

That is the same failure mode we have now — a stale replica, with a window that widens exactly when things
are going wrong — just with Stripe's lag substituted for our webhook's. It would narrow the window in the
common case and reopen it in the incident case. Not a fix.

**The distinction that matters is search versus list.** `GET /v1/checkout/sessions` is a *list*, filterable
on `payment_link` and `status`, read straight through with no such caveat — and it turned out to answer
exactly the question the guard needs to ask. That is §4.4, and it is the piece this section was originally
written to say did not exist. It was found while building, not while planning; the search endpoint's caveat
is prominent and the list endpoint's filters are not.

## 3.2 List subscriptions by customer — strongly consistent, but unreachable

`GET /v1/subscriptions?customer=…` is a list, not a search, and is strongly consistent. But a Payment Link
**cannot be pinned to an existing customer** (`customer` is not a parameter on payment link creation;
`customer_creation` only chooses whether one is made). Each completed session mints a *new* Customer.

So the three duplicate subscriptions sit on three different customer IDs, and a lookup keyed on the one
customer we know about finds only its own subscription. This is also why the incident was invisible in
Stripe's own UI until somebody sorted by subscription rather than by customer.

## 3.3 Restrict the shared link — wrong granularity

Payment Links do support `restrictions.completed_sessions.limit`. On a link shared by every customer on a
plan, a limit of 1 means the *first customer in the world* to subscribe closes the plan for everyone else.
The restriction is the right mechanism; the shared link is the wrong object to put it on.

---

# 4. The fix: move the constraint to Stripe, per tenant

Rule 14 says the database decides who got the slot, and application code translates the violation — never a
`SELECT` before an `INSERT`, because there is always a window between them. **The current guard is that
`SELECT`**, and it reads a replica.

The same rule applied across the Stripe boundary: put a constraint on the object Stripe enforces at the
moment of checkout, and let our code translate the refusal.

## 4.1 A Payment Link per tenant, limited to one completed session

At `POST /v1/billing/subscribe`, create a Payment Link for this organization:

```ts
stripe.paymentLinks.create({
  line_items: [{ price: priceFor(plan), quantity: 1 }],
  // The constraint. Stripe refuses the second checkout on this link itself,
  // on the path our API cannot reach. Rule 14, across the boundary.
  restrictions: { completed_sessions: { limit: 1 } },
  // Stamped onto the subscription, not just the session — see §4.3.
  subscription_data: {
    metadata: { tenantId },
    ...(trial ? { trial_period_days: trialPeriodDays } : {}),
  },
  metadata: { tenantId, plan },
});
```

All three parameters are confirmed present on `POST /v1/payment_links` (checked against the API reference,
spec version `2026-06-24.preview`).

What this preserves: the link is still permanent, so activation record §1.2's reason for rejecting a
Checkout Session — a 24-hour expiry against a 14-day window — still holds. Nothing about the emailed-link
flow changes for the owner.

What this costs: one Stripe API call at subscribe time, where §1.2 boasted of needing none, and a Stripe
client dependency in `BillingService` (injected, like `createPortalSession` already is). Rule 4 is
unaffected — unconfigured Stripe means no links can be created, which is the same `503` / "plan not sold"
the code already produces.

## 4.2 It also collapses the two-links-per-plan config

`subscription_data.trial_period_days` is settable per link. Lifecycle record §2.1 introduced `PlanLinks
{ trial, noTrial }` because *"a Payment Link's free trial is a property of the link and cannot be varied per
customer the way Checkout's `trial_period_days` can"*. That is true of a link created once in the dashboard.
It is false of a link created per tenant.

So four env vars go away and are replaced by two that are already required:

| Before                                          | After                       |
| ----------------------------------------------- | --------------------------- |
| `STRIPE_PAYMENT_LINK_STARTER`                   | `STRIPE_PRICE_STARTER`      |
| `STRIPE_PAYMENT_LINK_STARTER_NO_TRIAL`          | (already required)          |
| `STRIPE_PAYMENT_LINK_PROFESSIONAL`              | `STRIPE_PRICE_PROFESSIONAL` |
| `STRIPE_PAYMENT_LINK_PROFESSIONAL_NO_TRIAL`     | (already required)          |

Plans stop being configured in the Stripe dashboard, which was the stated cost of §1.2 and is now refunded.
The `PlanLinks` type, the superRefine pairing check in
[schema.ts:257](../packages/config/src/schema.ts#L257), and the `trial ? links.trial : links.noTrial`
branch all disappear. `trialUsedAt` keeps its job — it now chooses whether to *set* `trial_period_days`
rather than which of two URLs to send.

## 4.3 It also kills the orphan race

`subscription_data.metadata.tenantId` propagates to the created Subscription object, so every
`customer.subscription.*` event carries its own tenant. `findByStripeId` gains a fallback, and the ordering
problem that `OrphanEventError` exists to survive — lifecycle record §4, "`customer.subscription.created`
carries no `client_reference_id`" — stops being a problem for new subscriptions.

Keep `OrphanEventError` for subscriptions created before this change and for genuinely foreign ones. But it
stops being a routine, expected state.

## 4.4 The guard that finally does not depend on the webhook

The original question was whether the guard could be made not to depend on the path it protects. It can, and
this is how:

```ts
stripe.checkout.sessions.list({ payment_link: id, status: "complete", limit: 1 });
```

A **list**, not a search (§3.1) — strongly consistent, filtered by Stripe on both the link and the status.
Asked before re-issuing a link, it answers "has this organization already checked out?" correctly whether or
not a single Stripe event has reached us. No webhook, no worker, no local row is involved.

`billing.test.ts` asserts exactly that: the owner pays, nothing is mirrored locally, and the second request
is refused 409 with `subscription.count === 0` — proving the refusal came from Stripe and not from a row
that happened to arrive in time.

The result is stamped onto `consumed_at` so the next request costs no API call.

## 4.5 One link row per organization

The Stripe-side limit is worth nothing on its own. A double-clicked button that mints *two* links gives the
customer two allowances of one session each — so the restriction has to be paired with a guarantee that an
organization only ever has one link.

That is `SubscriptionCheckoutLink`, `@unique` on `tenantId`. A second `POST /subscribe` returns the first
request's stored URL rather than creating anything, and two concurrent requests resolve through a `P2002`
whose loser deactivates the link it just created in Stripe and returns the winner's. Rule 14, locally:
PostgreSQL decides, and application code translates.

Not a column on `Subscription`, because at the moment a link is issued there is no `Subscription` row — and
that absence is the entire bug.

## 4.6 Honest limits of the restriction

`completed_sessions.limit` is enforced by Checkout at completion time. Two checkouts completing in the same
instant on one link is a race inside Stripe that we cannot see and they do not document a guarantee for. It
closes the double-click, the re-opened email, the shared link, and the whole webhook-outage window — every
mechanism that produced this incident. It is not a proof, which is why it is one of three layers and not the
only one.

---

# 5. The other layers

The link restriction is the fix. These make it survive being wrong.

## 5.1 Layer 0 — make a duplicate loud (independent, shipped first)

**Built.** `activate()` refuses to overwrite a different, non-null `stripeSubscriptionId`: it keeps the
first subscription, writes a `billing.duplicate_subscription_detected` audit row (actor `SYSTEM`, both
subscription IDs in `after_json`) and logs at `error` so it reaches Sentry. The event is marked *processed*,
not failed — retrying it would not undo a charge, and a permanently failing row helps nobody.

Keeping the first is the conservative choice rather than the correct one; there is no correct one at that
point, because both subscriptions are real and both are charging. The first is the one whose trial, plan and
period have already been mirrored.

Shipped ahead of §4 deliberately: it needed no config change, no Stripe change and no decision, and it is
the difference between finding the incident on the first duplicate within minutes and finding the third by
chance.

It deliberately does **not** auto-cancel or refund. That is a money movement on a live account; it belongs
to an operator with the facts in front of them — including whether these are two organizations sharing a
domain, or one that legitimately upgraded.

## 5.2 Layer 2 — `/subscribe` returns the same link, not a new one

**Built**, and promoted from "another layer" to a required half of §4 — see §4.5 for why the Stripe-side
restriction does not work without it. Stored on its own table rather than on `Subscription`, for the reason
in §4.5's last line.

A plan change before paying deactivates the old link before creating the new one. That order matters: the
other way round leaves both live and both buyable for as long as the create takes.

Rule 16 applies here on its own terms — this is a write a customer retries, so it should carry an
`Idempotency-Key` claimed before the Stripe call. **Not done.** The unique constraint makes the duplicate
harmless (the second request returns the first's link), so this is tidiness rather than correctness, but it
is the one place this slice leaves a rule unapplied.

## 5.3 Layer 3 — a reconciliation sweep

**Not built.** A periodic worker job comparing what we think each tenant has against what Stripe actually
has: `subscriptions.search({ query: "metadata['tenantId']:'…'" })`, plus a sweep over all active
subscriptions on the account looking for two carrying the same `tenantId`.

The eventual consistency that disqualifies search as a *gate* (§3.1) is fine for a *sweep* — it runs on a
schedule, not in a request, and a minute of lag changes nothing.

This is the layer that catches whatever the other three miss, and its absence is the largest remaining gap.
It is also the only one of the four that needs no correctness argument to add later, which is why it was the
one deferred.

## 5.4 Layer 4 — keep the local guard, and fix its blind spot

**Built.** The guard is now the fast path that avoids a pointless Stripe call rather than the only defense,
and it refuses on **any** non-null `stripeSubscriptionId`, not only on a live status. That closes the
`INCOMPLETE` hole in §2.1 without touching `isLiveSubscription`, whose meaning ("entitled right now") is
correct for the entitlement decisions that also use it and must not be bent to serve this one.

---

# 6. Verification

Automated — **all green**, `billing.test.ts` and `stripe.processor.test.ts`:

1. A second `POST /subscribe` with no webhook processed at all returns the **identical** link, and exactly
   one link was created (§5.2). Asserted on the stub's call log, because "how many links exist for one
   organization" is the question this whole slice is about.
2. The owner pays, Stripe knows, we do not — no event recorded, `subscription.count === 0` — and the second
   request is refused 409 (§4.4). This is the incident, reproduced under its exact conditions.
3. `activate()` receiving a second `checkout.session.completed` with a different subscription ID keeps the
   first, writes the audit row, does not overwrite (§5.1).
4. A `customer.subscription.created` arriving before any checkout session binds via `metadata.tenantId`
   (§4.3) — and *refuses* to bind when that tenant's row already points at a different subscription, which
   would otherwise reintroduce §2.3's overwrite through a second door.
5. A row with `stripeSubscriptionId` set but status `INCOMPLETE` refuses a second link (§5.4's blind spot).
6. A plan with no price configured is not for sale; a second request for the same plan deactivates nothing.

Manual, against Stripe test mode — **not yet walked**. This is the half that matters and cannot be faked:

7. Complete a checkout on a per-tenant link, then reopen the same URL. Stripe must refuse it. **This is the
   assertion the whole slice rests on**; if it does not hold, §4 is wrong and needs rewriting rather than
   patching. The stub in `billing.test.ts` asserts our side of the contract and can say nothing about
   Stripe's.
8. With the worker stopped entirely, complete a checkout, then attempt a second from the pending dashboard.
9. Start the worker and confirm both the subscription and the tenant converge to the right state, and that
   `consumed_at` is stamped.
10. Confirm `trial_period_days` on a link created for a first-time organization actually produces a trialing
    subscription with a card on file and no charge — the behaviour §4.2 moved off the dashboard and into
    code.

---

# 7. Cleanup of the existing incident

**Still outstanding.** Separate from the code, and not done by this slice: the affected tenant holds three
live subscriptions that are still billing. Two must be cancelled in Stripe and the charges refunded.

That is a live-mode money movement. It is an operator action taken deliberately with the account in front of
them, not something a script does — and per the standing note about the Stripe MCP being connected in
**live mode**, live-mode state must be confirmed before any write.

Check first whether it is genuinely three subscriptions on one tenant or three on three customer IDs that
happen to be the same business (§3.2 makes the latter look like the former in the dashboard).

---

# 8. What was built

| Thing                                                          | Where                                              |
| -------------------------------------------------------------- | -------------------------------------------------- |
| `SubscriptionCheckoutLink`, `@unique` on `tenantId`             | `packages/db/prisma/schema.prisma`                  |
| Per-tenant link, `completed_sessions.limit = 1`, metadata       | `apps/api/…/billing/stripe.client.ts`               |
| `checkout.sessions.list` usage check                            | `apps/api/…/billing/stripe.client.ts`               |
| Reuse-or-create, plan-change replacement, P2002 loser path      | `apps/api/…/billing/billing.service.ts`             |
| Guard widened past `INCOMPLETE`                                 | `apps/api/…/billing/billing.service.ts`             |
| `paymentLinkClient` test seam on `buildApp`                     | `apps/api/src/app.ts`                               |
| Duplicate detection + audit row                                 | `apps/worker/…/stripe.processor.ts`                 |
| Attribution by `metadata.tenantId`                              | `apps/worker/…/stripe.processor.ts`                 |
| Four `STRIPE_PAYMENT_LINK_*` vars removed                       | `packages/config/src/schema.ts`, `.env.example`     |

## 8.1 A test trap this hit

`stripe_payment_link_id` is unique across the whole table, not per tenant — so the stub's `plink_1`,
`plink_2` collided with rows the *previous run* of the same suite had left behind. The symptom was a 500,
not a constraint error, because the service's `P2002` handler correctly interprets a duplicate key as "a
concurrent request won", looks for the winner by `tenantId`, finds none, and rethrows.

Exactly the trap `stripe.processor.test.ts` already documents for `stripe_subscription_id`, hit again in a
new column. Fixed the same way — suffix with the run.

---

# 9. Open questions

1. **Does `restrictions.completed_sessions.limit` behave on a subscription-mode link the way §6's test 7
   assumes?** The parameter is documented without a mode caveat, but this has not been walked. Everything in
   §4 is contingent on it, and the automated suite cannot tell us — it stubs Stripe.
2. **Is `inactive_message` shown for a *restriction*-exhausted link, or only for a manually deactivated
   one?** One is set (`stripe.client.ts`), pointing the owner back at their dashboard rather than leaving
   them on a bare "link no longer active" page. Whether Stripe renders it in this case is untested.
3. **Should the platform admin be able to issue a replacement link?** If a link is burnt by a checkout that
   then fails, the owner has no way to get another — `POST /subscribe` will refuse them, correctly, on the
   evidence available. Probably a `/platform` action rather than a self-service one, but it is not designed
   here. **This is the most likely support ticket this slice creates.**
4. **Should §5.3's sweep exist before this is trusted in production?** The three built layers are all
   preventive; nothing yet *detects* a duplicate that slips past them except §5.1, which only fires if the
   duplicate reaches `activate()`.
