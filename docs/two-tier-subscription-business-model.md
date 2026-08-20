# Two-tier subscription business model

## Launch catalogue

The Stripe/database identifiers remain `STARTER` and `PROFESSIONAL`; customers see the commercial names below.

| Internal plan  | Customer name   | Net monthly price | Entitlement                                                                                 |
| -------------- | --------------- | ----------------: | ------------------------------------------------------------------------------------------- |
| `STARTER`      | Form            |          9,990 Ft | Dashboard and public booking form; no AI chat                                               |
| `PROFESSIONAL` | AI Receptionist |         24,990 Ft | Form plus chat, widget, transcripts, 2M input and 400K output tokens per UTC calendar month |

Assisted configuration is an optional service sold separately for 29,990 Ft once. It is not MRR and is invoiced or sold manually during the concierge launch.

Prices exclude VAT. Stripe Price objects use `tax_behavior=exclusive`, and tenant Payment Links enable automatic tax. Production checkout must not open until the Stripe account's business origin, registrations, tax code, invoices, and EU reverse-charge handling have been reviewed with an accountant.

## Concierge owner onboarding

1. A platform administrator provisions the prospect tenant and owner invitation.
2. The owner accepts, signs in, and selects Form or AI Receptionist from the subscription screen.
3. The application creates and emails one tenant-specific, single-use Stripe Payment Link. The selected plan alone receives the tenant's one-time 30-day trial.
4. Verified Stripe events activate the tenant. The owner then configures services, providers, locations, schedules, and the booking page.
5. AI Receptionist owners can additionally configure the assistant and FAQs and install the widget.
6. Cards, invoices, cancellation, immediate prorated upgrades, and period-end downgrades are managed through Stripe's Customer Portal.

## AI operations

One SaaS-owned Anthropic key is used per deployment environment, never per tenant. Calls are attributed and limited by tenant in the application. Form tenants cannot discover public chat availability, resume old chat sessions, or use assistant administration APIs. At quota exhaustion, chat is unavailable until the next UTC month while the booking form continues normally.

`claude-sonnet-5` cost reporting uses the standard post-promotion price of $3/M input and $15/M output. Fully consuming 2M/400K therefore records a maximum list cost of $12 per AI tenant per month. Provider billing remains authoritative.

## Stripe catalogue setup

Run `pnpm stripe:catalog` to preview the intended catalogue and `pnpm stripe:catalog -- --verify` to check the configured Price IDs against it. Run `pnpm stripe:catalog -- --apply` only against the chosen Stripe test or live account. The idempotent script creates missing HUF products/prices and prints the two `STRIPE_PRICE_*` assignments; it does not overwrite existing prices or environment files.

Configure the Customer Portal so Starter-to-Professional upgrades are immediate and prorated, while Professional-to-Starter downgrades take effect at renewal. Complete the existing Stripe manual test checklist in test mode before using live Price IDs.

## Revenue reference

For `F` Form tenants and `A` AI tenants, gross MRR is `9,990F + 24,990A` Ft. At the referenced standard Hungarian EEA-card and Billing rates, an operational estimate after Stripe is `0.978 × gross MRR − 85 × (F + A)` Ft, before Anthropic, hosting, email, support, refunds, VAT liabilities, and business taxes.

One Form tenant and one AI tenant produce 34,980 Ft gross MRR and approximately 34,040 Ft after those Stripe fees, before the other costs above.
