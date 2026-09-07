# New Stripe sandbox bootstrap

This runbook connects local development to a clean Stripe sandbox and verifies
the complete subscription flow for the **Form** (`STARTER`) and
**AI Receptionist** (`PROFESSIONAL`) plans.

Subscriptions must be created through the application. Do not create them by
hand in Stripe: application checkout supplies the tenant reference, plan
metadata, trial policy, return URL, and one-use Payment Link restriction that
the webhook processor relies on.

Billingo Test, production rollout, discounts, and the assisted-configuration
fee are outside this exercise.

## 1. Stop and isolate the old sandbox

Stop the local API and worker before changing configuration. Existing local
organizations may contain Stripe IDs from the previous sandbox, so leave them
untouched and provision new Prospect organizations for this walkthrough.

Update the uncommitted root `.env`:

1. Replace `STRIPE_SECRET_KEY` with the new sandbox's `sk_test_...` key.
2. Remove the old values of `STRIPE_PRICE_STARTER`,
   `STRIPE_PRICE_PROFESSIONAL`, and `STRIPE_WEBHOOK_SECRET`.
3. Keep `TRIAL_PERIOD_DAYS=30`, or leave it unset to use the 30-day default.
4. Do not commit `.env`, keys, webhook secrets, or Price IDs copied from a
   private Stripe environment.

Do not continue until the key belongs to the intended sandbox. Stripe objects
and webhook signing secrets are environment-specific.

## 2. Configure the Stripe sandbox

In the Stripe Dashboard, with the new sandbox visibly selected:

- Complete the sandbox business profile and business origin/address.
- Set a recognizable public statement descriptor.
- Enable card payments.
- Enable Stripe Tax in test mode, add a test registration, and use
  `txcd_10103001` (Software as a service — business use) for this B2B product.
  Set `STRIPE_SAAS_TAX_CODE=txcd_10103001` before creating a future fresh
  catalog, or configure the same account default and assign it to both Stripe
  products.

The catalog uses tax-inclusive recurring HUF prices. Stripe's charge API uses
two decimal places for HUF, so the required API amounts are:

| Plan                             | Customer-facing price | Stripe `unit_amount` |
| -------------------------------- | --------------------: | -------------------: |
| Form (`STARTER`)                 |       9,990 HUF/month |             `999000` |
| AI Receptionist (`PROFESSIONAL`) |      24,990 HUF/month |            `2499000` |

An old Starter amount of `9990` means **99.90 HUF**, which Stripe rejects
because it is below the 175 HUF minimum charge.

## 3. Create and verify the catalog

From the repository root:

```bash
pnpm stripe:catalog -- --apply
```

The command is idempotent within one Stripe account. Copy the two printed IDs
into the uncommitted root `.env`:

```env
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_PROFESSIONAL=price_...
```

Verification, rather than the apply command's exit code, is the acceptance
gate:

```bash
pnpm stripe:catalog -- --verify
```

Expected output:

```text
STARTER: valid (9990 HUF/month, tax inclusive)
PROFESSIONAL: valid (24990 HUF/month, tax inclusive)
```

If verification reports a mismatch, do not start checkout. Confirm that the
configured IDs belong to this sandbox and retrieve each Price in Stripe to
check its currency, recurrence, tax behavior, and raw `unit_amount`.

## 4. Apply the database migration

Apply committed migrations to the local development database:

```bash
pnpm db:migrate:deploy
```

The checkout-link price migration records the immutable Stripe Price used to
create each link. A legacy link with no recorded Price ID is replaced instead
of being reused after a catalog correction.

## 5. Forward webhooks locally

Authenticate the Stripe CLI against the new sandbox, then run:

```bash
stripe listen \
  --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.paused,customer.subscription.resumed,customer.subscription.trial_will_end,invoice.paid,invoice.payment_failed,subscription_schedule.created,subscription_schedule.updated,subscription_schedule.canceled,subscription_schedule.released \
  --forward-to localhost:3001/v1/webhooks/stripe
```

Copy the listener's new `whsec_...` value into `STRIPE_WEBHOOK_SECRET` in
`.env`. Keep the listener running. Restart the API and worker after all Stripe
variables are set:

```bash
pnpm dev
```

The API verifies and stores webhook events; the worker processes them. Checkout
can succeed without the worker, but the organization will remain gated until
the events are processed.

## 6. Configure Customer Portal and collection policy

Under **Settings → Billing → Customer portal** in the sandbox:

- Enable cancellation at the end of the billing period and cancellation
  reasons.
- Enable plan switching between the two catalog Prices.
- Use `always_invoice` proration for upgrades.
- Keep the billing-cycle anchor unchanged.
- Schedule decreasing-item-amount changes at period end so downgrades do not
  create an immediate refund-shaped adjustment.
- Set trial update behavior to continue the existing trial.

Under **Settings → Billing → Automatic collection**, enable Smart Retries for
approximately one week and cancel the subscription after retries are
exhausted.

## 7. End-to-end acceptance

Provision two new Prospect organizations through `/admin/platform`, accept
both owner invitations, and leave existing organizations unchanged.

### Starter organization

1. Select Form and request the payment link.
2. Reload and request it again. The URL must be byte-identical and Stripe must
   still contain only one active link for this tenant.
3. Open checkout and use test card `4242 4242 4242 4242`, any future expiry,
   any CVC, and any postcode.
4. Confirm Stripe shows a trialing subscription, a saved payment method, no
   immediate charge, a 30-day trial, and `metadata.tenantId`.
5. Confirm webhook logs contain `checkout.session.completed` and
   `customer.subscription.created`.
6. Confirm the worker binds and mirrors the subscription, the tenant becomes
   `TRIAL`, and the checkout-link row has `consumed_at` set.
7. Reopen the completed URL and confirm Stripe refuses a second checkout.

### Professional organization

Repeat the flow while selecting AI Receptionist. Confirm the recurring amount
is 24,990 HUF and the mirrored plan is `PROFESSIONAL`.

### Portal and link lifecycle

- Before paying, change the selected plan and confirm the previous unused link
  becomes inactive and is replaced.
- From the subscribed Starter organization, use Customer Portal to upgrade to
  Professional. The existing trial must continue rather than ending early.
- Confirm an attempted downgrade is scheduled for the next renewal.
- Submit subscription again after checkout and expect a conflict rather than a
  second subscription.

## 8. Automated verification

From the repository root:

```bash
pnpm --filter @bam/api lint
pnpm --filter @bam/api check-types
pnpm --filter @bam/db lint
pnpm --filter @bam/db check-types
pnpm --filter @bam/api exec vitest run src/billing.test.ts
```

## Troubleshooting the 175 HUF error

1. Open the failed request in Stripe Workbench and note its Price ID.
2. Compare that ID with `STRIPE_PRICE_STARTER` in the running API environment,
   not only the `.env` file on disk.
3. Retrieve the Price and require raw `unit_amount=999000`, currency `huf`,
   monthly recurrence, and inclusive tax behavior.
4. If the raw amount is `9990`, replace the Price; Stripe Prices are immutable.
5. Restart the API after changing environment variables.
6. Retry with a newly provisioned organization. The application will
   deactivate legacy unused links whose recorded Price differs from the
   configured catalog Price.
