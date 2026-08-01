This is the execution record for the third slice of Epic 9, derived from
[phase-9-saas-administration.md](phase-9-saas-administration.md) §2.11 and §5.

# Phase 9 — Subscription and activation

## Implementation Record

**Document version:** 1.0 — built and tested 2026-07-30.
**Scope:** the pending owner's dashboard (what they may not do yet, and why), and the subscription that
lifts it — an emailed Stripe Payment Link, a signature-verified webhook, and the activation it triggers.
**Depends on:** [phase-9-owner-onboarding.md](phase-9-owner-onboarding.md) — the owner has to be able to
sign in before there is anything to show them — and [phase-9-saas-administration.md](phase-9-saas-administration.md)
for §2.4 (the write-gate exemption, the most dangerous detail here), §2.11 (B2, disable with a reason),
§2.9 (webhook idempotency) and §5.1, **which this document amends** (see §7).
**Exit criteria:** A pending owner sees what they cannot do and why, and one thing they can · An owner can
obtain a payment link without anyone handling card details · Paying flips the organization to ACTIVE without
manual intervention · A redelivered Stripe event changes nothing

---

# 1. Context

Owner onboarding works end to end. A provisioned owner receives a link, sets a password, and lands signed-in
on `/dashboard` in `PENDING_SUBSCRIPTION`. That is where it stops being good.

The API is right: `tenantAcceptsWrites` allows only `ACTIVE | TRIAL`, so every write is refused. The
interface has not been told. It renders six clickable navigation links that all 403, and an overview showing
a members table with no indication that the organization is unpaid, what that prevents, or what to do about
it.

§2.11 decided this already — **disable with a reason, plus a first-class pending panel** — and §7 put it
more sharply: an owner who clicks "add a service" and gets a 403 has been failed by the interface. This slice
builds that screen and the subscription step it points at.

## 1.1 Why an emailed link, and what it does not buy

The product owner's stated reason (2026-07-30) was to avoid handling card details. That reason does not
survive inspection, and it is recorded here rather than quietly implemented, because a decision defended by a
wrong reason gets reversed by the first person who notices:

**Stripe's hosted page takes the card either way.** A button that redirects and a link in an email lead to
the same page; no card data touches our servers in either design. Emailing changes nothing about PCI scope.

What emailing genuinely buys is worth having, and is the reason to keep:

- The owner can **forward the link to whoever holds the company card** — a finance person, a co-owner, an
  accountant — none of whom need an account with us or a reason to be in our dashboard.
- The link survives the session. An owner who closes the tab has it in their inbox.

Both remain true for as long as the product is sold to businesses rather than individuals, which is the
premise of the whole epic.

## 1.2 Why a Payment Link and not a Checkout Session

This is the substantive change from §5.1's original decision, which said Stripe Checkout.

**A Checkout Session expires within 24 hours.** The subscribe window is `ONBOARDING_WINDOW_DAYS`, default 14. Emailing a Checkout Session URL therefore produces a link that is dead for thirteen of the fourteen days
it is supposed to cover — and dead in the least helpful way, since the owner discovers it at the moment they
finally sat down to pay.

A **Payment Link** is a permanent, reusable URL created once per plan and held in config. It never expires,
needs no API call to produce, and carries the tenant through `?client_reference_id=<tenantId>`.

The cost is real and should be stated: plans are configured in the Stripe dashboard rather than in our code,
so adding a plan means creating a link there and adding an environment variable. That is acceptable for a
product with two plans (§5), and it is the trade that makes the emailed link work at all.

---

# 2. The pending dashboard

## 2.1 The gate is a property of the tenant, not of the user

The navigation is gated on `tenant.status === "PENDING_SUBSCRIPTION"`, **not** on a permission. The owner
holds every permission there is; what is missing is a paid subscription. Gating on `can()` here would be
both wrong and misleading — it would suggest the fix is a role change.

`/v1/me` already reports `tenant.status` and gains `subscribeBy` and `daysRemaining`. `daysUntil` in
`platform.service.ts` already computes the latter, flooring at zero so an overdue organization reads as 0
rather than a negative number; it moves somewhere both callers can import rather than being written twice.

`daysRemaining` is null when `subscribeBy` is null, which is exactly the internal-organization case (§2.2) —
so the countdown disappears for demo tenants without a special case. That falling out of the model is a sign
the model is right, and the screen must not reintroduce the special case by rendering "0 days".

## 2.2 Disabled, not hidden, and disabled accessibly

§2.11 chose B2 over hiding for a stated reason: this screen is doing sales work, and an owner who cannot see
the shape of the product has less reason to pay for it.

The implementation detail that matters: a gated item renders as a `<span aria-disabled="true">`, **not** as a
`<Link>` with a class that makes it look grey. An anchor remains focusable and activates on Enter regardless
of how it is painted, so the "disabled" one would still navigate — to a screen that 403s, which is the exact
failure this work exists to remove.

Each disabled item points at one shared explanation node through `aria-describedby`, so a screen reader
hears _why_ rather than only that something is unavailable. A `title` tooltip is not a substitute: it is
invisible to keyboard users and unreliable for assistive technology.

## 2.3 The overview says what happens next, in order

Three steps, of which exactly one is actionable:

```
1. Subscribe                                        [ Subscribe ]   ← live
2. Add your providers, services and locations       once subscribed
3. Open your booking page and take bookings         once configured
```

The members panel stays. Seeing your own name on an otherwise empty screen is reassuring rather than noise.

---

# 3. Subscription

## 3.1 The write gate must not block the act that lifts it

**The single most dangerous detail in this slice**, and §2.4 says so in the epic record: subscribing is
itself a write. Gate it with everything else and the owner can never subscribe, can never leave
`PENDING_SUBSCRIPTION`, and their organization expires while they are trying to pay for it. It would be
found by the first real customer.

`requireWritableTenant` is opt-in today, so the billing module simply does not register it. That is the
right outcome reached by a fragile route — nothing stops a later hand adding the guard "for consistency".
The protection is therefore a **test**, not a convention: an owner in `PENDING_SUBSCRIPTION` reaches
`POST /v1/billing/subscribe` and is refused `POST /v1/services`. Written before the route works.

## 3.2 The request produces a link and requests an email; it does not send one

`POST /v1/billing/subscribe` builds
`${paymentLink}?client_reference_id=${tenantId}&prefilled_email=${ownerEmail}` and writes an
`outbox_event` of type `SUBSCRIPTION_LINK_REQUESTED`.

It does **not** call Resend inline. Provisioning already learned this (owner-onboarding §2.4 and the comment
in `platform.service.ts`): a third-party HTTP call inside a request that also has to answer the browser is
how a failure gets swallowed, and the predecessor swallowed exactly this one, so an owner who never received
their link looked identical to one who did.

The response carries `{ paymentUrl, emailedTo }`, so the page shows the link **and** says where it was sent.
An owner sitting in front of the screen should not be blocked on mail delivery, and showing the URL adds no
exposure — it is the same hosted page the email points at.

`client_reference_id` is the entire join key. Without it, a completed payment arrives as a webhook with no
way to tell which organization paid.

Checkout is refused when the tenant already holds a live subscription — §2.7 lists this among the things
worth taking from `booking-for-all`, and it is what stops a double-clicked button billing twice.

## 3.3 The webhook records and returns; the worker decides

Per §2.9. Stripe delivers at-least-once and retries anything slow, so acting inline is what _causes_ the
duplicate delivery it is trying to handle.

- **Raw body.** Fastify's JSON parser destroys the bytes `constructEvent` needs to verify the signature.
  The parser is registered with `{ parseAs: "buffer" }` **inside the webhook plugin only** — Fastify's
  encapsulation keeps it from affecting every other route, which a global parser would not.
- **A documented rule-2 exception.** The body is a signed blob whose validator is Stripe's signature check,
  not Zod. `auth.plugin.ts` already carries the same exception for Better Auth's routes, with the same
  reasoning: a second schema would be a divergent source of truth.
- **Insert into `stripe_events` keyed on Stripe's event id, then 200.** A duplicate insert is a redelivery
  and is answered 200 without reprocessing — the database refuses it and application code translates, rather
  than checking first (rule 14).

Processing runs in the worker as a **poller over `stripe_events WHERE processed_at IS NULL`**, mirroring
`outbox.poller.ts`. That shape is not invented here: `StripeEvent` already carries `processedAt` and
`lastError`, which is a model designed for exactly this loop. A BullMQ queue would add a second mechanism
where the table already implies one.

| Event                           | Effect                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `checkout.session.completed`    | tenant → `ACTIVE`, `subscribeBy` → null, upsert `Subscription`, one transaction |
| `customer.subscription.updated` | mirror plan, status, `currentPeriodEnd`, `cancelAtPeriodEnd`                    |
| `customer.subscription.deleted` | tenant → `SUSPENDED`, **never `CLOSED`**                                        |

`deleted` → `SUSPENDED` and not `CLOSED` is §2.6's distinction doing its work: a former customer's data
carries obligations — invoices, bookings taken, their customers' personal data — and closure is reserved for
prospects who never subscribed at all.

Unrecognised event types are marked processed and ignored. A worker that treated them as failures would
retry them forever.

---

# 4. Data model

None. `Subscription` and `stripe_events` were migrated with the platform-administration work and no code has
read them yet; this slice is what they were for.

The unique constraint on `Subscription.tenantId` is what makes activation idempotent, so a redelivered
completion finds the tenant already `ACTIVE` and does nothing.

---

# 5. Config

```text
STRIPE_SECRET_KEY                  optional
STRIPE_WEBHOOK_SECRET              required if STRIPE_SECRET_KEY is set
STRIPE_PAYMENT_LINK_STARTER        optional
STRIPE_PAYMENT_LINK_PROFESSIONAL   optional
```

Paired as a `superRefine`, for the same reason `RESEND_API_KEY`/`EMAIL_FROM` are: a secret key with no
webhook secret fails at the worst possible moment — after a customer has paid, when the event arrives and
cannot be verified.

`stripe` is a new dependency, API only, behind a lazy `getStripe()` (rule 4). It is needed for exactly one
call — `webhooks.constructEvent` — because a Payment Link requires no API call to produce.

The subscription screen offers only plans whose link is configured. A button leading to a blank Stripe page
is worse than a plan that is not offered.

---

# 6. Verification

**Walked end to end against Stripe test mode on 2026-07-31**, on account `acct_1PMXZAGzrhgSGwTy`: a real
test payment moved `wellness` from `PENDING_SUBSCRIPTION` to `ACTIVE`, cleared `subscribe_by`, and wrote
`STARTER / ACTIVE` with both Stripe identifiers. Replaying the same event afterwards changed nothing, which
is the idempotency claim in §3.3 demonstrated rather than asserted.

Stripe setup is manual and one-off: two Payment Links in test mode, one per plan, with
`client_reference_id` accepted.

1. `docker start bam-redis`. Leave `RESEND_API_KEY`/`EMAIL_FROM` commented out — the logging provider prints
   the payment link to the worker log, so the whole flow is testable with no Resend account. Uncomment both
   together when a real email is wanted; config validation refuses one without the other.
2. `stripe listen --forward-to localhost:3001/v1/webhooks/stripe`; put the printed `whsec_…` in
   `STRIPE_WEBHOOK_SECRET`. **Read §6.1 first — both ways this goes wrong cost an afternoon.**
3. Provision, accept, sign in. Expect five dimmed navigation items with an explanation, Overview and
   Subscription live, and the three-step panel.
4. Subscribe. Expect the link on screen and the same link in the worker log.
5. Pay with `4242 4242 4242 4242`.
6. Expect `ACTIVE` within a poll interval, the navigation alive, the panel gone. Replay the event to confirm
   the redelivery changes nothing.
7. `pnpm db:discard-organization <domain> --yes` to go round again.

## 6.1 Two ways the webhook silently does nothing

Both of these were hit on 2026-07-31, one after the other, and neither produces an error anywhere the
developer is looking. The symptom of both is identical and misleading: **the payment succeeds, Stripe shows
everything correct, and the application never changes.** `stripe_events` stays empty, which is the tell — an
empty table means nothing ever arrived, as distinct from arriving and failing, which would leave a row with
`last_error` set.

**1. `stripe listen` is not running.** Stripe has no route to `localhost`. The events are not failed or
retried — they were never attempted, because no endpoint exists for them. Check with `stripe listen`'s own
output, not the Stripe dashboard's webhook logs, which will show nothing at all.

**2. The `whsec_` belongs to a different account's listener.** This one is nastier because it looks like it
should work. The CLI's listen secret is per-account: run `stripe listen` while logged into account A, put
its `whsec_` in `.env`, then forward events from account B, and every request is rejected 401 at
`constructEvent`. The listener log shows `<-- [401]` — which is the only place the failure is visible, since
the API logs it at `warn` deliberately (an unverified body is attacker-controlled on a public endpoint).

The underlying hazard is that **the CLI and this project can be pointed at different Stripe accounts**. If
`stripe config --list` shows an `account_id` other than the one whose `sk_test_` is in `.env`, then plain
`stripe listen` is wrong and every command needs `--api-key`:

```bash
stripe listen --api-key sk_test_… --forward-to localhost:3001/v1/webhooks/stripe
stripe listen --api-key sk_test_… --print-secret     # the whsec_ that belongs in .env
stripe events resend evt_… --api-key sk_test_…       # replay after fixing either fault
```

Recovering costs nothing: replay the event. That is what §3.3's idempotency is for, and replaying the same
`checkout.session.completed` twice was how it got demonstrated.

## 6.2 A hypothesis worth recording as wrong

`current_period_end` was suspected of having moved onto subscription items in recent Stripe API versions,
which would have left `currentPeriodEnd` null. Checked directly against the live subscription object: it is
present at **both** the root and on the item, so `periodEndOf` reading the root is correct.

The null observed before that check had a duller cause — only `checkout.session.completed` had been
replayed, and `activate()` does not set the field. `customer.subscription.updated` is what carries it, and
once replayed the value mirrored correctly.

---

# 7. What this amends in the epic record

`phase-9-saas-administration.md` §5.1 records **D1 — Stripe Checkout plus the customer portal** as the
chosen mechanism, decided 2026-07-30. This slice changes the checkout half of that to a **Payment Link**,
for the reason in §1.2: a Checkout Session expires within 24 hours and the subscribe window is 14 days, so
an emailed Checkout URL is dead for most of the period it exists to cover.

Unchanged: D2 (embedded Payment Element) stays refused, D3 (manual activation by a platform admin) stays
both the interim and the permanent bank-transfer path, and the customer portal remains the answer for
self-service billing once a subscription exists.

---

# 8. What was built

| Piece                                                | Where                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `daysUntil`, `subscribablePlanSchema`                | `packages/contracts/src/billing.ts` — shared, with its own tests    |
| `subscribeBy` / `daysRemaining`                      | `me.routes.ts`, `tenant-context.plugin.ts`                          |
| Gated navigation                                     | `dashboard-shell.tsx` — `aria-disabled` spans, one shared reason    |
| The three-step panel                                 | `dashboard.tsx` `PendingPanel`                                      |
| `POST /v1/billing/subscribe`, `GET .../subscription` | `modules/billing/billing.{routes,service}.ts`                       |
| `POST /v1/webhooks/stripe`                           | `modules/billing/webhook.routes.ts` — scoped raw-body parser        |
| `getStripe()`                                        | `modules/billing/stripe.client.ts`                                  |
| Event processing                                     | `apps/worker/src/stripe/stripe.{poller,processor}.ts`               |
| `SUBSCRIPTION_LINK` + template                       | `notification-engine`, migration `…_subscription_link_notification` |
| The subscription screen                              | `subscription-screen.tsx`, `/dashboard/subscription`                |
| 15 tests                                             | `apps/api/src/billing.test.ts`, `stripe.processor.test.ts`          |

## 8.1 Deviations and details worth knowing

- **The Stripe poller runs even without Redis.** It touches PostgreSQL only, so a customer who pays while
  Redis is down is still activated — only their email waits. That fell out of not using a queue and is worth
  keeping.
- **The webhook route is registered only when Stripe is configured.** With no key nothing could verify a
  signature, and an endpoint that accepted unverified webhooks would be worse than no endpoint. Asserted by
  a test that expects 404 when unconfigured.
- **`apiVersion` is pinned to the SDK's own literal.** The Stripe types accept only their latest version
  string, so bumping the `stripe` package turns into a compile error rather than a silent behaviour change.
- **A plan with no configured link is not offered**, rather than offered and failing at Stripe.
- **An unrecognised subscription status throws.** §2.7 refused the predecessor's free-text status column;
  this is the same decision at the other end of the pipe.
- **`planFromMetadata` falls back to STARTER rather than throwing.** A customer who has paid must end up
  active; being on the cheaper plan is a billing correction, whereas a thrown error is a locked-out customer
  who has been charged.

## 8.2 A test trap this hit, twice in one epic

`stripe_subscription_id` is unique across the whole table. The first draft of the processor tests used fixed
literals (`sub_123`), so the suite passed once and failed on every subsequent run against the same database —
the second run collided with the row the first had left. Every Stripe id in those tests is now suffixed with
the per-run token, like every other identifier in the integration suites.

This is the same shape as the trap recorded in
[phase-9-owner-onboarding.md](phase-9-owner-onboarding.md) §6.2: these suites share one long-lived database,
so anything a test writes into a globally unique column has to be unique per run, and anything it asserts
the absence of has to be scoped.

---

# 9. Open questions

1. ~~**The customer portal is not built here.**~~ **Closed 2026-07-31** by
   [phase-9-customer-portal.md](phase-9-customer-portal.md). Worth knowing if you are reading this document
   for the processor: that slice found `mirrorSubscription` reading a cancellation wrong — flexible billing
   mode sets `cancel_at` and leaves `cancel_at_period_end` false — and not mirroring a plan change at all.
2. **Which plan does a prospect get?** The screen lets the owner choose. Whether the platform admin should
   instead pin it at provisioning — having just sold them a specific plan — is a sales-process question, not
   a technical one.
3. ~~**`invoice.payment_failed` is not handled**~~ **Closed 2026-08-01** by
   [phase-9-subscription-lifecycle.md](phase-9-subscription-lifecycle.md). The notification is built; the
   grace period turned out not to need building at all — Stripe's dunning is it (§2.3 there).
