This is the execution record for the fourth slice of Epic 9, closing open question 1 of
[phase-9-subscription-and-activation.md](phase-9-subscription-and-activation.md) and the "not built" row
for the customer portal in [phase-9-saas-administration.md](phase-9-saas-administration.md) §1.2.

# Phase 9 — Customer portal

## Implementation Record

**Document version:** 1.0 — built 2026-07-31, automated tests green, **§6 not yet walked against Stripe**.
**Scope:** self-service billing for an owner who already has a subscription — changing the card, reading
invoices, cancelling — plus the two mirroring gaps the portal exposes in the webhook processor.
**Depends on:** [phase-9-subscription-and-activation.md](phase-9-subscription-and-activation.md) for the
subscription that a portal session needs to exist at all, §3.3 for the event processor this extends, and
§2.4 for the write-gate exemption this route inherits.
**Exit criteria:** An owner with a subscription reaches Stripe's portal in one click · A cancellation
scheduled there shows on our screen · A plan changed there is mirrored, or provably left alone rather than
guessed · An organization with no subscription is told so rather than shown a broken button

---

# 1. Context

The subscription slice took the owner's money and activated their organization. It gave them nowhere to go
afterwards. An owner who wants to change a card that is about to expire, read last month's invoice, or stop
paying has exactly one route today: email us and have somebody open the Stripe dashboard by hand.

§5.1 of the epic record decided this a slice ago — **the customer portal is the answer for self-service
billing once a subscription exists** — and that decision survives the Payment Link amendment in §7
untouched. This slice builds it.

## 1.1 Why the portal is not emailed, when the payment link was

The subscribe flow emails its link on purpose (§1.1 of the subscription record): a Payment Link is permanent,
it is shared by every customer on that plan, and forwarding it to whoever holds the company card is the
point.

**A portal session is the exact opposite of that on every axis**, and the two must not be built the same way:

- It is **short-lived** — a matter of minutes, unused — so an emailed one is dead before the recipient reads
  it. This is the same failure mode as the Checkout Session §1.2 rejected, at a tenth of the timescale.
- It is **bearer authentication into a billing account.** Anyone holding the URL can read invoices, see the
  card on file and cancel the subscription, with no sign-in. The payment link authenticates nobody because
  it grants nothing but the ability to pay us.

So: generated on demand, for a signed-in owner holding `BILLING_MANAGE`, redirected to immediately, never
persisted, never logged, never sent anywhere. The response is a URL the browser is expected to consume at
once, which is why the route is a `POST` returning it rather than a link the page can render.

## 1.2 POST, not GET

§6 of the epic record lists this route as `GET /v1/billing/portal`. It is built as `POST`, and the
difference is not pedantry.

Creating a portal session is a side effect against Stripe. A `GET` is fair game for a browser prefetch, a
link preview, a corporate proxy that warms links, and a `<link rel="prefetch">` Next.js may add on its own —
each of which would create a session and, worse, burn the short window before the owner has clicked
anything. The rule the whole codebase already follows is that a `GET` is safe to repeat; this is not.

---

# 2. The route

```
POST /v1/billing/portal    →  201 { url }
```

`BILLING_MANAGE`, so the owner alone (rule 10, and the same permission the rest of the module uses).

**It inherits the write-gate exemption**, and unlike `POST /subscribe` this one is exempt for a second,
independent reason. `tenantAcceptsWrites` allows `ACTIVE | TRIAL`, so a `SUSPENDED` organization accepts no
writes — and `SUSPENDED` is exactly the state `customer.subscription.deleted` leaves a former customer in
(§3.3 of the subscription record). Gating the portal would mean the one screen that could fix a billing
problem is unreachable precisely to the people with a billing problem. The billing module registers no
`requireWritableTenant` at all, so this falls out; a test pins it, because a convention expressed by
omission is not a protection (§2.4).

## 2.1 What it refuses, and with what

| Condition                                  | Answer                                               |
| ------------------------------------------ | ---------------------------------------------------- |
| Stripe unconfigured (`STRIPE_SECRET_KEY`)  | `503 SERVICE_UNAVAILABLE`                            |
| No subscription, or no Stripe customer id  | `409 VALIDATION_FAILED` — nothing to manage yet      |
| Stripe rejects the call                    | `503 SERVICE_UNAVAILABLE`, cause logged, not returned |

The last row is the one worth stating. The commonest cause by far is that **no portal configuration exists
in the Stripe dashboard**, which Stripe reports as an ordinary API error. Letting that surface as a 500
would page somebody over a setup step; `ensurePortalConfig()` — creating the configuration on demand — is
listed in §2.7 among the things worth taking from the predecessor and is deliberately *not* built here,
because a configuration created by code is a billing policy nobody reviewed.

`GET /v1/billing/subscription` gains **`portalAvailable`**, so the screen can decide whether to render the
button at all. Same reasoning as `availablePlans`: a button that leads to a 503 is worse than a button that
is absent.

## 2.2 The Stripe call is injected, not imported

`BillingService` takes an optional `createPortalSession` function. `buildApp` supplies the Stripe-backed one
when a secret key is configured and omits it otherwise, which is what produces the 503 above with no
`if (env...)` inside the service.

This is dependency injection for a testing reason, stated plainly: every other billing behaviour is
integration-tested against a real database, but there is no real Stripe to test against and no appetite for
a network call in a suite. The seam lets the happy path be asserted — a session is requested for *this*
tenant's customer id, and the returned URL is what the route sends — without stubbing modules.

---

# 3. What the portal exposes in the processor

Building the portal is small. What it changes about the events we receive is not, and this is the part worth
the reading.

Until now every subscription in the system was created by a Payment Link and never touched again. The portal
makes `customer.subscription.updated` a real event carrying real changes, and two of them the processor was
getting wrong in ways nothing could have noticed.

## 3.1 A cancellation may not say `cancel_at_period_end`

`mirrorSubscription` reads `cancel_at_period_end`, which is correct for **classic** billing mode. In
**flexible** billing mode — Stripe's newer default — a cancellation scheduled from the customer portal sets
`cancel_at` to a timestamp and leaves `cancel_at_period_end` **false**.

The failure is silent and total: an owner cancels, Stripe agrees, our screen keeps saying "Renews on …"
until the day the subscription vanishes and the organization is suspended without warning. Nothing errors,
nothing retries, no row looks wrong.

`cancelAtPeriodEnd` is therefore set from **either** signal. Its name now describes the classic field rather
than the question it answers, which is "is this subscription ending?" — the honest fix would be a
`cancel_at` column, and that is a migration this slice does not need: §2.8 mirrors only what the application
acts on, and what it acts on is the boolean.

## 3.2 A plan change must be mirrored, or provably not guessed

The portal can be configured to let a customer switch plans. `activate()` reads the plan from the checkout
session's metadata, which a subscription update does not carry in the same place.

The plan is resolved, in order, from `subscription.metadata.plan`, then `items.data[0].price.metadata.plan`.
**If neither is present the existing plan is left alone.** That asymmetry with `planFromMetadata`'s
fall-back-to-STARTER is deliberate and the reasoning inverts cleanly:

- At activation there is no plan yet and the customer has paid, so *any* answer beats a locked-out customer,
  and the cheapest is the safe one to be wrong with.
- At update there is already a plan that was right five minutes ago. Guessing STARTER here would silently
  **downgrade a customer who just upgraded**, and would do it on every unrelated update event thereafter.

**This makes a Stripe setup step load-bearing**, and it is recorded rather than assumed: if plan switching
is turned on in the portal configuration, the `plan` metadata key must be set on both prices. Without it
Stripe will happily move the customer and our record will not follow.

## 3.3 What is deliberately not done: reactivation

A tempting one-liner: when a mirrored status comes back `active`, lift a `SUSPENDED` tenant to `ACTIVE`.

Refused. `SUSPENDED` has two causes — Stripe deleted the subscription, and a platform admin used
`PATCH /v1/platform/organizations/:id/status` — and the tenant row does not record which. A Stripe event
would then silently reverse an operator's suspension of an organization suspended for abuse, non-payment by
transfer, or an investigation. Recovering a genuinely cancelled customer is a deliberate act and stays with
the platform admin until §2.6.1's reopen exists.

---

# 4. Data model

None. No migration, no new environment variable — the portal needs `STRIPE_SECRET_KEY`, which billing
already requires, and a return URL built from `APP_BASE_URL`, which every other outbound link in the API
already uses.

---

# 5. Web

The subscription screen grows a third state. It already rendered "no subscription, choose a plan" and "link
sent"; the subscribed branch was a dead end that said "everything is unlocked" and offered nothing.

- **Manage billing** — posts to the portal route and replaces the location with the returned URL. Rendered
  only when `portalAvailable`.
- The redirect is `window.location.assign`, not a new tab: the owner is leaving the application for a
  hosted page that will send them back to `/dashboard/subscription`, and a portal session in an
  abandoned background tab is a session that has expired by the time anyone looks at it.
- The cancellation notice the screen already had now actually fires, because §3.1 makes the flag true.

---

# 6. Verification

**Not yet performed.** This is the procedure, not a record of having run it — unlike the subscription
slice, which was walked end to end before its §6 was written. What is verified today is the automated
suite: 7 tests covering both refusals, the session request itself, the write-gate exemption in the
`SUSPENDED` state, and both processor faults in §3. The one thing they cannot cover is that Stripe's portal
opens, because that needs a configuration saved in a dashboard.

Continues §6 of the subscription record, on the same test-mode account, with `stripe listen` running and its
`whsec_` in `.env` — **re-read that record's §6.1 before assuming a webhook is broken**; both silent
failures it describes apply unchanged here.

One-off Stripe setup, in test mode: **Settings → Billing → Customer portal**, save a configuration. Turn on
payment method updates, invoice history and cancellation. If plan switching is turned on, set
`metadata[plan]` to `STARTER` / `PROFESSIONAL` on both prices, per §3.2.

1. Subscribe and pay as in the previous record, so the organization is `ACTIVE` with a subscription row.
2. Open `/dashboard/subscription`. Expect the plan, the renewal date, and **Manage billing**.
3. Click it. Expect Stripe's portal, and the return link back to the same screen.
4. Cancel the subscription there. Expect `customer.subscription.updated`, and the screen to read
   "Ends on …" within a poll interval — this is §3.1, and it is the assertion the whole slice turns on.
5. Un-cancel in the portal. Expect the screen back to "Renews on …".
6. With no `STRIPE_SECRET_KEY`, expect no button rather than a broken one.

---

# 7. What was built

| Piece                                      | Where                                                       |
| ------------------------------------------ | ----------------------------------------------------------- |
| `createStripePortalSession`                | `modules/billing/stripe.client.ts`                          |
| `portalSession`, `portalAvailable`         | `modules/billing/billing.service.ts`                        |
| `POST /v1/billing/portal`                  | `modules/billing/billing.routes.ts`                         |
| Wiring, present only when Stripe is set up | `app.ts`                                                    |
| `cancel_at` and plan mirroring             | `apps/worker/src/stripe/stripe.processor.ts`                |
| Manage billing                             | `apps/web/src/components/subscription-screen.tsx`, en + hu  |
| 7 tests                                    | `apps/api/src/billing.test.ts`, `stripe.processor.test.ts`  |

---

# 8. Open questions

1. **`invoice.payment_failed` is still unhandled**, so §5's `PAYMENT_FAILED` notification and the grace
   period before suspension remain outstanding. The portal is what such a notification would link to, so
   these are now one piece of work rather than two.
2. **`ensurePortalConfig()`** — see §2.1. Worth revisiting only if a second Stripe account is ever set up
   from scratch.
3. **Reopening a suspended customer** stays manual, per §3.3, until §2.6.1's reopen route exists.
