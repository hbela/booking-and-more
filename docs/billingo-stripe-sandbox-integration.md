# Stripe → Billingo Sandbox Integration

## Purpose

Every positive HUF Stripe subscription invoice creates one paid electronic AAM
invoice in Billingo Test. Stripe remains the source of truth for the amount;
Billingo renders and stores the Hungarian invoice. Zero-value trial invoices are
not sales and are skipped.

Stripe's charge API represents HUF in fillér (`24,990 Ft` is `2499000`), while
Billingo's document API accepts whole forints. The worker converts exactly once
at that boundary and rejects fractional-forint totals it cannot mirror without
rounding.

The Fastify webhook remains deliberately small:

```text
Stripe invoice.paid
  → POST /v1/webhooks/stripe
  → signature verification and stripe_events insert
  → worker claims the event
  → Stripe invoice/customer snapshot retrieval
  → Billingo partner synchronization
  → Billingo invoice creation/reconciliation
  → local Billingo document mapping
```

## Configuration

The following server-side variables form one all-or-nothing group:

```env
BILLINGO_API_KEY=
BILLINGO_BASE_URL=https://api.billingo.hu/v3
BILLINGO_BANK_ACCOUNT_ID=
BILLINGO_DOCUMENT_BLOCK_ID=
BILLINGO_VAT_CODE=AAM
```

`BILLINGO_PRODUCT_ID` is intentionally ignored. Copying a Billingo catalogue
price would create a second monetary source of truth and could disagree with a
discounted or changed Stripe invoice.

The validated environment also requires Stripe to be completely configured.
Never commit keys or copy `.env` values into documentation, logs, or test
fixtures.

## Idempotency and recovery

- `billingo_invoices.stripe_invoice_id` is unique locally.
- The Stripe invoice ID is sent as Billingo `vendor_id`.
- Before POSTing a document, the worker calls
  `GET /documents/vendor/{stripeInvoiceId}`. If Billingo accepted an earlier
  request but the local database write failed, the retry records that existing
  document instead of creating another invoice.
- A Billingo failure leaves the Stripe event unprocessed, with `last_error`, so
  the existing worker retry loop can recover it.
- Existing Billingo partners are updated from Stripe's finalized billing
  snapshot before subsequent invoices.

## Smoke test

Connectivity and configured IDs can be checked without creating anything:

```bash
pnpm billingo:smoke
```

Creating the labeled 24,990 HUF test invoice is opt-in:

```bash
pnpm billingo:smoke -- --apply
```

The command uses a daily stable `vendor_id`, so repeating it on the same day
reconciles the existing document. It never emails the invoice.

## End-to-end acceptance

1. Use a dedicated sandbox tenant whose `trialUsedAt` is already populated, so
   Checkout charges immediately without changing the normal 30-day trial.
2. Complete Stripe Checkout with a sandbox card.
3. Confirm the Stripe event is processed without `last_error`.
4. Confirm Billingo Test contains one 24,990 HUF paid AAM invoice with the
   Stripe invoice ID in its comment/vendor reference.
5. Replay the Stripe event and confirm neither Billingo nor the local database
   gains a second invoice.

Production VAT rules, foreign/EU tax mapping, refunds, credit notes, and
automatic Billingo email delivery are intentionally outside this sandbox slice.
