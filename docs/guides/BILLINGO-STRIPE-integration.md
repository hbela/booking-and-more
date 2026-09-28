Yes. And for the first integration test I would **not use Billingo’s built-in Stripe connector**.

That connector is mainly the other direction: **Billingo creates an invoice → customer pays that invoice through Stripe**, and Billingo says its connector requires a live Stripe registration. ([Billingo][1])

For Booking and More, your desired architecture is:

```text
Booking and More
      │
      ▼
Stripe Checkout / Subscription
      │
      ▼
Stripe Sandbox payment succeeds
      │
      ▼
Stripe webhook: invoice.paid
      │
      ▼
Booking and More Fastify API
      │
      ▼
Billingo V3 API
      │
      ▼
Billingo TEST invoice
```

That is exactly what I recommend testing first.

## 1. Create a Billingo test account

Billingo provides a dedicated test environment for API development. Their developer site explicitly links to a **teszt fiók**, currently at the Billingo demo environment, and says integrations can be tested separately before going live. ([developers.billingo.hu][2])

Use:

[Billingo developer portal](https://developers.billingo.hu/?utm_source=chatgpt.com)

and select **teszt fiók**.

Do **not** use your eventual production Billingo company for this first exercise.

Inside the test account, create some dummy company data such as:

```text
Booking and More Test
Budapest
Hungary
```

No real invoice or NAV submission should be part of our sandbox exercise.

---

## 2. Generate a Billingo V3 API key

In Billingo test:

**Beállítások → API kulcsok → Új API kulcs**

Choose:

```text
Version: V3
Permission: Read + Write
Name: booking-and-more-dev
```

Billingo recommends V3 for new integrations. V3 keys can have read-only or read/write scope. ([Billingo][3])

Copy the key immediately into your backend environment:

```env
BILLINGO_API_KEY=your-test-v3-key
BILLINGO_BASE_URL=https://api.billingo.hu/v3
```

Never expose this key in your React/Next.js frontend.

All Billingo API calls authenticate using:

```http
X-API-KEY: your-api-key
```

Billingo's V3 documentation uses this header. ([Billingo][4])

---

# 3. Before Stripe, test Billingo by itself

This is important.

We first want to establish:

```text
Fastify → Billingo test
```

before adding:

```text
Stripe → Fastify → Billingo
```

Otherwise, when something fails we won't know which side caused it.

Try this from your terminal:

```bash
curl \
  -H "X-API-KEY: YOUR_BILLINGO_TEST_API_KEY" \
  https://api.billingo.hu/v3/bank-accounts
```

You should get JSON back rather than `401 Unauthorized`.

Billingo's API supports partners, bank accounts, document blocks, products and invoices. ([Billingo][4])

---

# 4. Configure a few things in Billingo test

A Billingo invoice needs several IDs.

Billingo's documented invoice example requires:

```text
partner_id
block_id
bank_account_id
```

and then the invoice items. ([Billingo][4])

For our first test I would create these manually in Billingo:

### Bank account

For example:

```text
Name: OTP Test
Currency: HUF
```

The account can be dummy/test data.

### Invoice block

Create a standard invoice block, perhaps:

```text
Booking and More Test
```

### Product

Create:

```text
Booking and More — AI Receptionist
Unit: hó
Currency: HUF
Price: 24 900 Ft
```

Billingo products support unit, VAT rate, currency, net price and gross price. ([Billingo][5])

For now, the VAT value is **only test data**. We should not make the production VAT decision until your accountant confirms whether you will operate under AAM or normal VAT.

---

# 5. Add Billingo configuration to your Fastify API

Something like:

```env
# Stripe Sandbox
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Billingo TEST
BILLINGO_API_KEY=...
BILLINGO_BASE_URL=https://api.billingo.hu/v3

BILLINGO_BANK_ACCOUNT_ID=123
BILLINGO_DOCUMENT_BLOCK_ID=456
BILLINGO_PRODUCT_ID=789
```

Keep sandbox and production variables completely separate.

Later in Coolify I would have:

```text
Development / Staging
    Stripe Sandbox
    Billingo Test

Production
    Stripe Live
    Billingo Live
```

That separation will save you a lot of trouble.

---

# 6. Create a very small Billingo API client

For TypeScript you don't need a special Billingo SDK. REST is enough.

For example:

```ts
const BILLINGO_BASE_URL = process.env.BILLINGO_BASE_URL ?? "https://api.billingo.hu/v3";

async function billingoRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BILLINGO_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": process.env.BILLINGO_API_KEY!,
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(`Billingo API error ${response.status}: ${body}`);
  }

  return response.json() as Promise<T>;
}
```

Now your entire app talks to Billingo through one small wrapper.

---

# 7. Create the Billingo customer/partner

The Stripe Customer and the Billingo Partner represent essentially the same customer in the two systems.

For example, Stripe might contain:

```text
cus_R123456
```

and Billingo:

```text
partner_id = 172
```

Your database should eventually store that mapping:

```text
User / Organization
      │
      ├─ stripeCustomerId
      │    cus_R123456
      │
      └─ billingoPartnerId
           172
```

Billingo lets you create a partner through the V3 API. The official example includes name, address, email and tax number. ([Billingo][4])

For example:

```ts
interface CreatePartnerInput {
  name: string;
  email: string;
  postalCode: string;
  city: string;
  address: string;
}

async function createBillingoPartner(input: CreatePartnerInput) {
  return billingoRequest<{ id: number }>("/partners", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      address: {
        country_code: "HU",
        post_code: input.postalCode,
        city: input.city,
        address: input.address,
      },
      emails: [input.email],
    }),
  });
}
```

For a B2B customer, we will later also add:

```text
Hungarian tax number
EU VAT number
```

where applicable.

Billingo requires a billing address for partners. ([Billingo][6])

That means your Stripe Checkout should eventually collect a **billing address**, not just an email address.

---

# 8. The Stripe event we should use is `invoice.paid`

This is important for subscriptions.

It would be tempting to generate the Billingo invoice from:

```text
checkout.session.completed
```

but that only represents completing Checkout.

For recurring SaaS subscriptions we want:

```text
invoice.paid
```

because Stripe emits it whenever a subscription invoice is successfully paid, including later renewal periods. Stripe explicitly recommends handling `invoice.paid` for recurring subscription billing. ([Stripe Docs][7])

So:

```text
Month 1
Stripe invoice.paid
→ Billingo invoice

Month 2
Stripe invoice.paid
→ Billingo invoice

Month 3
Stripe invoice.paid
→ Billingo invoice
```

Exactly what we need.

---

# 9. Stripe webhook in Fastify

Your endpoint could be:

```text
POST /webhooks/stripe
```

Conceptually:

```ts
fastify.post("/webhooks/stripe", async (request, reply) => {
  const signature = request.headers["stripe-signature"];

  const event = stripe.webhooks.constructEvent(
    rawBody,
    signature!,
    process.env.STRIPE_WEBHOOK_SECRET!,
  );

  switch (event.type) {
    case "invoice.paid":
      await handleStripeInvoicePaid(event.data.object);
      break;
  }

  return reply.send({ received: true });
});
```

There is one important detail with Fastify:

**Stripe webhook signature verification must use the original raw request body.**

Stripe explicitly warns that parsing or changing the JSON before calling `constructEvent()` causes signature verification to fail. ([Stripe Docs][8])

So in Fastify we'll configure raw-body handling specifically for this route.

---

# 10. Then generate the Billingo invoice

Conceptually:

```ts
async function handleStripeInvoicePaid(stripeInvoice: Stripe.Invoice) {
  const customerId = stripeInvoice.customer as string;

  const customer = await stripe.customers.retrieve(customerId);

  // 1. Find/create Billingo Partner
  const partnerId = await getOrCreateBillingoPartner(customer);

  // 2. Generate invoice
  await createBillingoInvoice({
    partnerId,
    stripeInvoice,
  });
}
```

The Billingo document would look approximately like this:

```ts
async function createBillingoInvoice({
  partnerId,
  stripeInvoice,
}: {
  partnerId: number;
  stripeInvoice: Stripe.Invoice;
}) {
  const today = new Date().toISOString().slice(0, 10);

  return billingoRequest("/documents", {
    method: "POST",

    body: JSON.stringify({
      partner_id: partnerId,

      block_id: Number(process.env.BILLINGO_DOCUMENT_BLOCK_ID),

      bank_account_id: Number(process.env.BILLINGO_BANK_ACCOUNT_ID),

      type: "invoice",

      fulfillment_date: today,
      due_date: today,

      payment_method: "bankcard",

      language: "hu",
      currency: "HUF",

      electronic: true,
      paid: true,

      items: [
        {
          product_id: Number(process.env.BILLINGO_PRODUCT_ID),
          quantity: 1,
        },
      ],

      comment: `Stripe invoice: ${stripeInvoice.id}`,
    }),
  });
}
```

Billingo's documented V3 flow uses this same structure of `partner_id`, `block_id`, `bank_account_id`, dates, payment method, language, currency and invoice items. ([Billingo][4])

We'll verify the exact current V3 schema against Swagger when implementing it; Billingo recommends their current OpenAPI documentation as the source of truth. ([Billingo][9])

---

# 11. Prevent duplicate invoices

This part is essential.

Stripe may deliver the same webhook more than once.

Therefore never simply do:

```text
invoice.paid
→ create Billingo invoice
```

without checking your database first.

Add something like:

```text
BillingInvoice
─────────────────────────────
id
stripeInvoiceId UNIQUE
billingoDocumentId
billingoInvoiceNumber
createdAt
```

Then:

```ts
const existing = await prisma.billingInvoice.findUnique({
  where: {
    stripeInvoiceId: stripeInvoice.id,
  },
});

if (existing) {
  return;
}
```

Only generate a new Billingo invoice when one doesn't already exist.

This gives us **idempotency**.

That's extremely important for financial integrations.

---

# 12. Testing locally with Stripe Sandbox

Stripe recommends either generating actual sandbox transactions or forwarding sandbox events with the Stripe CLI. ([Stripe Docs][7])

During development:

```bash
stripe login
```

then:

```bash
stripe listen \
  --forward-to localhost:3000/webhooks/stripe
```

Stripe gives you something like:

```text
whsec_xxxxxxxxx
```

Put that in:

```env
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxx
```

Then perform a genuine Checkout purchase in your Stripe sandbox using a Stripe test card.

For example the usual successful test card:

```text
4242 4242 4242 4242
```

with any future expiry and any CVC.

This is better than initially using:

```bash
stripe trigger invoice.paid
```

because Stripe notes that CLI-generated events contain artificial data that doesn't necessarily correspond to your real test subscription objects. ([Stripe Docs][10])

For our end-to-end integration we want a **real sandbox Checkout subscription**.

---

# 13. Our first end-to-end test

The test should be extremely simple.

Create a test customer:

```text
Name:
Teszt Elek

Email:
teszt@example.com

Billing address:
1133 Budapest
Teszt utca 1.
Hungary
```

Then purchase:

```text
Booking and More — AI Receptionist

24 900 HUF / month
```

using:

```text
4242 4242 4242 4242
```

Expected sequence:

```text
Stripe Checkout succeeds
        ↓
Stripe creates/updates subscription
        ↓
Stripe invoice becomes paid
        ↓
invoice.paid webhook
        ↓
Fastify verifies Stripe signature
        ↓
Fastify finds/creates Billingo partner
        ↓
Fastify calls Billingo test API
        ↓
Billingo creates test invoice
        ↓
Fastify saves Billingo document ID
```

Success criterion:

> You open Billingo Test and see a **24 900 HUF Booking and More test invoice for Teszt Elek**.

At that point we have proven the architecture.

---

# 14. One architectural change I recommend

Do **not** have Stripe calculate a legal invoice and Billingo independently calculate another invoice from scratch.

Stripe should be our **payment source of truth**:

```text
Stripe invoice
 ├─ amount
 ├─ currency
 ├─ customer
 ├─ tax
 └─ payment status
```

and Billingo should be the **Hungarian legal invoice renderer/reporting system**:

```text
Stripe financial data
          ↓
Booking and More
          ↓
Billingo
          ↓
Hungarian invoice
```

That prevents discrepancies such as:

```text
Stripe: 24 900 Ft
Billingo: 24 899 Ft
```

or differing VAT calculations.

We'll map the Stripe invoice line items into Billingo rather than independently reconstructing the amount.

---

## I suggest we implement it in three very small stages

| Stage | Test                                                    |
| ----- | ------------------------------------------------------- |
| **A** | Fastify → Billingo Test creates one manual test invoice |
| **B** | Stripe Sandbox `invoice.paid` reaches Fastify           |
| **C** | Stripe Sandbox → Fastify → Billingo Test invoice        |

Do **Stage A first**.

Once that works, the rest becomes much easier.

Your immediate next task is therefore:

**Create the Billingo test account and a V3 Read+Write API key.**

After you have that, **do not send me the key**. Tell me only that you have it, and I can give you the exact Fastify/TypeScript implementation for Stage A, including the Billingo client, partner creation, product lookup, document-block lookup, and creation of the first 24,900 Ft test invoice.

[1]: https://support.billingo.hu/content/2460221443 "Stripe - Kézikönyv - Support - Billingo"
[2]: https://developers.billingo.hu/ "Billingo For Developers"
[3]: https://support.billingo.hu/content/951124273?utm_source=chatgpt.com "API kulcsok - Kézikönyv - Support - Billingo"
[4]: https://support.billingo.hu/content/446136358?utm_source=chatgpt.com "Billingo API v3 - Swagger példa - Kézikönyv - Support - Billingo"
[5]: https://support.billingo.hu/content/147947595?utm_source=chatgpt.com "Termék létrehozása - Kézikönyv - Support - Billingo"
[6]: https://support.billingo.hu/content/265158661?utm_source=chatgpt.com "Partner létrehozás - Kézikönyv - Support - Billingo"
[7]: https://docs.stripe.com/billing/subscriptions/webhooks?utm_source=chatgpt.com "Using webhooks with subscriptions | Stripe Documentation"
[8]: https://docs.stripe.com/webhooks?lang=node&utm_source=chatgpt.com "Receive Stripe events in your webhook endpoint | Stripe Documentation"
[9]: https://support.billingo.hu/content/104562845?utm_source=chatgpt.com "Hol találom az API dokumentációt? - Kézikönyv - Support - Billingo"
[10]: https://docs.stripe.com/billing/testing?locale=en-GB&utm_source=chatgpt.com "Test your Billing integration | Stripe Documentation"
