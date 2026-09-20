Document and Implement the New Stripe Sandbox Bootstrap
Summary
Save the agreed procedure as docs/new-stripe-sandbox-bootstrap.md, connect local development to the empty Stripe sandbox, configure the complete Stripe billing flow, and validate real Starter and Professional sandbox subscriptions.
Implementation

1. Create the documentation file containing:
   - Required Stripe dashboard configuration.
   - Safe .env transition steps.
   - Catalog, migration, webhook, and startup commands.
   - Customer Portal policy.
   - End-to-end acceptance checklist and minimum-charge troubleshooting.
2. Stop local billing processes and update the uncommitted .env with the new sandbox secret; remove old Price IDs and webhook secret.
3. Configure the new sandbox’s business origin, statement descriptor, card payments, Stripe Tax test registration, and SaaS tax category.
4. Run pnpm stripe:catalog -- --apply, save the generated Starter and Professional Price IDs in .env, and require pnpm stripe:catalog -- --verify to report:
   - Starter: 9,990 HUF/month, Stripe unit_amount=999000.
   - Professional: 24,990 HUF/month, Stripe unit_amount=2499000.
5. Apply local database migrations with pnpm db:migrate:deploy.
6. Start a Stripe CLI listener for the 13 supported billing events, put its new signing secret in .env, and restart API, worker, and web processes.
7. Configure Customer Portal cancellation, upgrades, deferred downgrades, unchanged billing anchors, trial preservation, and retry/cancellation policy.
   Verification

- Run API and database lint, type-check, and focused billing tests.
- Provision two new Prospect organizations without altering existing organizations.
- Complete a Starter checkout for one and a Professional checkout for the other using Stripe’s successful test card.
- Confirm prices, 30-day trials, saved payment methods, webhook processing, tenant activation, subscription records, and consumed checkout links.
- Confirm repeated submission reuses one link, plan changes deactivate the prior unused link, and completed links cannot be reused.
- Exercise Starter-to-Professional switching through Customer Portal and ensure the trial continues.
- If the 175 Ft error persists, inspect the failed Stripe request and reject any configuration where Starter uses unit_amount=9990.
  Assumptions
- Billingo Test, production deployment, discounts, and the assisted-configuration fee remain deferred.
- Subscriptions are created through application checkout, never manually in Stripe.
- Secrets remain local and are not written to documentation or committed.
