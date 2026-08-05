For **booking-and-more**, I would attach the Stripe subscription to the tenant/organization rather than the individual user. That matches the reusable multi-tenant SaaS direction of the project. fileciteturn0file0

## Recommended subscription policy

Use one simple, predictable policy:

| Customer action          | When it takes effect          | Billing result                         | Access                    |
| ------------------------ | ----------------------------- | -------------------------------------- | ------------------------- |
| Cancel during trial      | End of trial                  | No charge                              | Until trial ends          |
| Cancel paid subscription | End of current billing period | No refund                              | Until period ends         |
| Standard → Premium       | Immediately                   | Charge prorated difference immediately | Premium immediately       |
| Premium → Standard       | Next billing period           | No refund or credit now                | Premium until period ends |
| Immediate cancellation   | Immediately, support-only     | Optional prorated refund               | Revoked immediately       |

This is easier for customers to understand and much easier to maintain than allowing every possible combination.

“End of the month” should mean **the end of the customer’s current billing period**, not the last calendar day of the month.

---

# 1. The free trial

I recommend advertising it as a **30-day free trial**, rather than “one month.” Calendar months have different lengths, while Stripe’s `trial_period_days: 30` is unambiguous.

Collect the payment method during Checkout, but do not charge it until the trial ends. Stripe Checkout collects a payment method by default for subscription trials; explicitly setting `payment_method_collection: "always"` makes the intended behaviour clear. Stripe supports both `trial_period_days` and an exact `trial_end` timestamp. citeturn227098search0turn227098search9

```ts
const checkoutSession = await stripe.checkout.sessions.create({
  mode: "subscription",

  customer: organization.stripeCustomerId,

  line_items: [
    {
      price: selectedPriceId,
      quantity: 1,
    },
  ],

  payment_method_collection: "always",

  subscription_data: {
    trial_period_days: 30,

    metadata: {
      organizationId: organization.id,
    },

    // Defensive fallback if you later allow trials without cards.
    trial_settings: {
      end_behavior: {
        missing_payment_method: "cancel",
      },
    },
  },

  client_reference_id: organization.id,

  success_url: `${env.WEB_URL}/settings/billing?checkout=success`,
  cancel_url: `${env.WEB_URL}/pricing?checkout=cancelled`,
});
```

## Prevent repeated trials

Stripe should not be your only protection against trial abuse. Store trial eligibility in your database:

```prisma
model OrganizationSubscription {
  id                   String   @id @default(cuid())
  organizationId       String   @unique

  stripeCustomerId     String   @unique
  stripeSubscriptionId String?  @unique
  stripePriceId        String?

  plan                 SubscriptionPlan?
  status               SubscriptionStatus?

  trialStartedAt       DateTime?
  trialEndsAt          DateTime?
  trialUsedAt           DateTime?

  currentPeriodEndsAt  DateTime?
  cancelAtPeriodEnd    Boolean  @default(false)

  pendingPlan          SubscriptionPlan?
  pendingPlanStartsAt  DateTime?

  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt
}
```

Before creating Checkout:

```ts
if (subscription.trialUsedAt) {
  // Create the subscription without subscription_data.trial_period_days.
}
```

Make the trial available once per organization, not once per user account. Otherwise, another owner or administrator could repeatedly create trials for the same business.

Stripe sends `customer.subscription.trial_will_end` three days before the trial ends, which you can use for an in-app notification or email. citeturn681189search2turn681189search5

---

# 2. Use Stripe Customer Portal for normal subscription management

Since the portal is already working, let Stripe handle:

- payment-method updates;
- invoices;
- cancellation;
- cancellation reasons;
- Standard/Premium switching;
- prorations and payment authentication.

The portal can be configured to cancel subscriptions at the end of the billing period, switch plans, prorate changes and schedule downgrades for the next billing period. citeturn259868search1turn922548search0

Configure the portal approximately like this:

### Cancellation

- **Allow cancellation:** enabled
- **Cancellation timing:** end of billing period
- **Cancellation reasons:** enabled
- **Retention coupon:** optional, later

### Plan switching

- **Allow plan switching:** enabled
- **Upgrades:** apply immediately
- **Proration:** invoice immediately
- **Downgrades:** schedule at period end
- **Billing-cycle anchor:** unchanged
- **Trial update behaviour:** continue trial

Stripe added `trial_update_behavior: "continue_trial"` in API version `2025-09-30.clover`. Without this configuration on older API versions, changing the plan through the portal can end the trial and trigger billing immediately. citeturn460376search0turn460376search2

Conceptually, the portal configuration should contain:

```ts
features: {
  subscription_cancel: {
    enabled: true,
    mode: "at_period_end",
  },

  subscription_update: {
    enabled: true,
    default_allowed_updates: ["price"],

    proration_behavior: "always_invoice",
    billing_cycle_anchor: "unchanged",

    schedule_at_period_end: {
      conditions: [
        {
          type: "decreasing_item_amount",
        },
      ],
    },

    trial_update_behavior: "continue_trial",
  },
}
```

The exact TypeScript fields available depend on your installed `stripe` package and configured Stripe API version.

---

# 3. Cancellation at period end

This should be the normal customer-facing cancellation.

```ts
async function scheduleCancellation(stripeSubscriptionId: string): Promise<Stripe.Subscription> {
  return stripe.subscriptions.update(stripeSubscriptionId, {
    cancel_at_period_end: true,
  });
}
```

The subscription remains active until its current period ends. Stripe sends `customer.subscription.updated` when `cancel_at_period_end` changes, and later sends `customer.subscription.deleted` when the subscription actually ends. The customer can also reverse the scheduled cancellation before the period ends. citeturn511985search3turn644797search1

```ts
async function undoCancellation(stripeSubscriptionId: string): Promise<Stripe.Subscription> {
  return stripe.subscriptions.update(stripeSubscriptionId, {
    cancel_at_period_end: false,
  });
}
```

Your UI should show:

> Your Premium subscription will end on September 18, 2026. You can continue using Premium until then.

And provide:

> Keep my subscription

---

# 4. Changing between Standard and Premium

## Standard → Premium: immediate upgrade

The customer receives Premium features immediately and pays only the prorated difference for the rest of the current period.

When implementing this yourself, use:

```ts
async function upgradeSubscription(
  stripeSubscriptionId: string,
  premiumPriceId: string,
): Promise<Stripe.Subscription> {
  const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);

  const item = subscription.items.data[0];

  if (!item) {
    throw new Error("Subscription has no subscription item.");
  }

  return stripe.subscriptions.update(stripeSubscriptionId, {
    items: [
      {
        id: item.id,
        price: premiumPriceId,
      },
    ],

    proration_behavior: "always_invoice",

    // Apply the upgrade only if the new invoice is successfully handled.
    payment_behavior: "pending_if_incomplete",
  });
}
```

`always_invoice` creates and attempts to collect the prorated invoice immediately. Stripe recommends using pending updates when a subscription change generates an immediate invoice, so the change does not become effective unless payment succeeds. citeturn634010search1turn422738search10turn922548search7

The portal is preferable here because it also displays the amount and handles 3D Secure or payment failures.

## Premium → Standard: scheduled downgrade

Do not downgrade immediately. Otherwise, the customer could lose Premium features while still having paid for Premium access.

Schedule the change for the next renewal:

> Your plan will change to Standard on September 18, 2026.

Stripe Customer Portal can automatically create a subscription schedule for a downgrade at the end of the billing period. citeturn922548search0turn922548search3

Because subscription schedules introduce additional state, store these fields when you encounter them:

```prisma
stripeScheduleId     String?
pendingPlan          SubscriptionPlan?
pendingPlanStartsAt  DateTime?
```

Do not directly modify a subscription that has an attached schedule without accounting for the schedule; otherwise, one update can overwrite another scheduled update.

---

# 5. Immediate cancellation and prorated refunds

Do **not** expose this as the normal self-service cancellation option.

Make it an administrative action for situations such as:

- duplicate billing;
- a verified service outage;
- an accidental purchase reported immediately;
- a legal or contractual refund requirement;
- a goodwill decision by support.

The important Stripe distinction is:

> A negative proration is not automatically returned to the customer’s card.

Stripe can calculate a credit for unused time, but negative prorations are not automatically cash refunds. To send money back, you must create a separate refund against the original PaymentIntent or Charge. citeturn644797search0turn681189search8

## Practical phase-one implementation

For the first version, perform exceptional refunds through the Stripe Dashboard.

Stripe’s cancellation interface allows an administrator to choose:

- prorated refund;
- full refund of the last payment;
- no refund.

This is safer than implementing financial edge cases before you actually need them. citeturn644797search1

## Later API implementation

A custom administrative flow should:

1. Retrieve the subscription and latest paid invoice.
2. Preview the cancellation using one fixed `prorationDate`.
3. Display the refund amount to the administrator.
4. Require confirmation.
5. Cancel immediately.
6. Create a partial refund against the last paid PaymentIntent.
7. Store the operation and idempotency keys.
8. Wait for refund-related webhooks before marking the refund complete.

Pseudo-implementation:

```ts
type ImmediateCancellationRequest = {
  subscriptionId: string;
  refundAmount: number;
  paymentIntentId: string;
  operationId: string;
};

async function cancelImmediatelyWithRefund(input: ImmediateCancellationRequest): Promise<void> {
  // For flat-rate monthly subscriptions, cancel without creating an
  // additional Stripe customer credit because a cash refund follows.
  await stripe.subscriptions.cancel(
    input.subscriptionId,
    {
      invoice_now: false,
      prorate: false,
    },
    {
      idempotencyKey: `cancel:${input.operationId}`,
    },
  );

  await stripe.refunds.create(
    {
      payment_intent: input.paymentIntentId,
      amount: input.refundAmount,

      metadata: {
        subscriptionId: input.subscriptionId,
        operationId: input.operationId,
        reason: "unused_subscription_time",
      },
    },
    {
      idempotencyKey: `refund:${input.operationId}`,
    },
  );
}
```

Do not calculate the refund as simply:

```ts
(monthlyPrice / 30) * unusedDays;
```

That can become incorrect when discounts, taxes, billing timestamps or different month lengths are involved. Stripe supports previewing subscription changes, and recommends using the same proration timestamp for the preview and final operation. citeturn511985search0turn511985search7

Also record a temporary state such as `REFUND_PENDING`, because cancellation and refund are two separate API calls and cannot form one database-style transaction.

---

# 6. Webhooks must control application access

Do not grant, remove or change plan access based only on the browser returning from Checkout or the portal. The portal return URL only indicates that the customer returned to your application.

Use Stripe webhooks as the source of truth. Stripe recommends listening for subscription changes, cancellations, successful invoices and failed invoices. citeturn922548search6turn634010search3

At minimum, handle:

```ts
const relevantEvents = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
  "charge.refunded",
  "refund.updated",
];
```

A Fastify webhook skeleton:

```ts
app.post(
  "/webhooks/stripe",
  {
    config: {
      rawBody: true,
    },
  },
  async (request, reply) => {
    const signature = request.headers["stripe-signature"];

    if (typeof signature !== "string" || !request.rawBody) {
      return reply.code(400).send({ error: "Invalid webhook request" });
    }

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(request.rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch {
      return reply.code(400).send({ error: "Invalid Stripe signature" });
    }

    const alreadyProcessed = await prisma.stripeWebhookEvent.findUnique({
      where: { stripeEventId: event.id },
    });

    if (alreadyProcessed) {
      return reply.send({ received: true });
    }

    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        await synchronizeSubscription(subscription);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await deactivateSubscription(subscription.id);
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        await recordSuccessfulInvoice(invoice);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        await recordFailedInvoice(invoice);
        break;
      }
    }

    await prisma.stripeWebhookEvent.create({
      data: {
        stripeEventId: event.id,
        eventType: event.type,
      },
    });

    return reply.send({ received: true });
  },
);
```

Use a unique database constraint on `stripeEventId` so webhook retries cannot apply the same operation twice.

---

# 7. Entitlement rules

Your application should translate Stripe state into application access:

```ts
function determineAccess(status: Stripe.Subscription.Status): boolean {
  return status === "trialing" || status === "active";
}
```

In production, add an explicit grace-period policy:

- `trialing`: access allowed;
- `active`: access allowed;
- `past_due`: access temporarily allowed for perhaps three to seven days;
- `unpaid`: access revoked;
- `canceled`: access revoked;
- `incomplete`: do not grant full access;
- `incomplete_expired`: access revoked.

Stripe notes that `active` does not necessarily mean every older invoice has been paid, so your access policy should also consider the latest invoice and your chosen grace period. citeturn634010search3

---

# 8. Testing checklist

Use Stripe sandboxes and test clocks to cover:

1. Trial starts successfully.
2. Trial is cancelled and no payment occurs.
3. Trial reaches its end and first payment succeeds.
4. First payment fails.
5. Standard upgrades to Premium halfway through a period.
6. Upgrade requires 3D Secure.
7. Upgrade payment fails.
8. Premium downgrade is scheduled.
9. Scheduled downgrade takes effect at renewal.
10. Cancellation is scheduled.
11. Scheduled cancellation is reversed.
12. Subscription reaches its cancellation date.
13. Immediate cancellation and partial refund.
14. Duplicate webhook delivery.
15. Webhooks arrive in an unexpected order.

Stripe test clocks can advance subscription time and simulate trial endings, renewals, plan changes and payment failures without waiting for real billing periods. citeturn634010search2turn634010search10

## Final practical architecture

Use **Stripe Checkout** for starting the 30-day trial, **Stripe Customer Portal** for normal plan changes and period-end cancellations, and a small **admin-only refund workflow** for exceptional immediate cancellations.

The most important business rules are:

- upgrades happen immediately with proration;
- downgrades happen at renewal;
- normal cancellations happen at renewal;
- trials continue when switching plans;
- cash refunds are exceptional and explicit;
- webhooks, not redirects, determine access.
