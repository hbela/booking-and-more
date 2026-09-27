# Subscription business model

## Catalogue

| Internal plan     | Customer name     | Monthly price (HUF, AAM) | Chats per UTC month |
| ----------------- | ----------------- | -----------------------: | ------------------: |
| STARTER           | Form              |                    9,990 |                None |
| PROFESSIONAL      | Professional      |                   29,900 |                 150 |
| PROFESSIONAL_PLUS | Professional Plus |                   59,800 |                 300 |

Both AI plans include the booking form, chat, website widget and transcripts. Each clinic may start at most 30 chats per UTC day. Unused chats do not roll over. There are no automatic overage charges; the booking form remains available when chat allowance is exhausted.

Existing Professional subscriptions keep their Stripe price and receive 150 chats per month. Set STRIPE_PRICE_PROFESSIONAL_LEGACY to a comma-separated list of their Price IDs. These IDs resolve incoming subscription and schedule events but are never offered for new purchases. New Professional purchases use STRIPE_PRICE_PROFESSIONAL; Plus uses STRIPE_PRICE_PROFESSIONAL_PLUS. Existing subscriptions are not repriced by catalogue setup.

Assisted configuration remains a separate optional service at 29,990 HUF once. The seller's existing AAM tax configuration remains unchanged: no automatic Stripe tax, unspecified price tax behavior, and Billingo AAM invoices.

## Chat accounting

A patient explicitly starts a chat. A successfully created session consumes one allowance even if abandoned. Opening a widget, refreshing, changing display language, or replaying an identical idempotency key does not consume another chat. Admission and both period counters are atomic across API processes. Upgrades and downgrades do not clear counters.

Each session has an absolute 15-minute deadline, 500 code points per trimmed patient message, 5,000 patient code points total, 40 turns, 80,000 cumulative model input tokens and 4,000 cumulative model output tokens. Each generation is limited to 1,024 output tokens and at most 30 seconds or the remaining session lifetime. Limits are configured through the validated CHAT_* and CONVERSATION_* variables documented in .env.example.

Count the complete prepared model request before generation, reserving a 10% input margin. Instructions, tool definitions, catalogue and repeated history count on every request. Characters are never treated as tokens. A per-conversation database claim prevents simultaneous processing. Confirmations and holds recheck the chat deadline inside their database transactions. Unknown provider failures retain the reserved allowance conservatively; they do not trigger automatic paid retries.

The patient sees a countdown, a one-minute warning, and a translated goodbye when the chat closes. Closure releases unused holds and pending confirmations but never removes a committed booking. The transcript remains readable by its session credential. Paste/drop prevention is a browser affordance; API character, rate, deadline and token checks remain authoritative.

The owner subscription screen shows monthly usage and remaining chats. Internal/demo tenants bypass subscription quotas but retain per-chat safety limits. Production public AI requires Redis for shared IP rate limits. Each chat also has a database-enforced ten-message-per-minute limit.

## Owner content allowance

Each clinic has a shared 10,000-Unicode-code-point allowance **per language** (Hungarian, English, German and French) across the company profile, all service descriptions, and FAQ questions plus answers. Owners can allocate the whole allowance to one description. Counts trim each field first; names and other booking fields are outside this allowance. Base service descriptions belong to the clinic's default language. Explicit translations count in their own language; the legacy company-description alias is not counted twice. Inactive FAQs and archived service descriptions still count.

The owner editors show saved usage plus the current form's changes. Over-limit saves are rejected atomically without truncation, preserving the draft. Existing over-limit content can be reduced, and unrelated edits are allowed, but the total cannot grow while above the limit. All knowledge writers share a database lock, including default-language changes. No migration or environment change is needed for this allowance.

AI requests use the requested company-profile translation, falling back to the default-language profile and then the legacy profile. Service descriptions use the selected translation or the original description. FAQs are included only for the requested language. Translation fallback is not counted as a second stored copy, and the existing complete-request token budget remains authoritative for AI costs.

Run the owner browser checks against a local web server at port 3000 with `pnpm --filter @bam/web exec playwright test --config playwright.knowledge.config.ts`.

## Economics

Anthropic's pricing page checked on 2026-09-26 lists Sonnet 5 at USD 2 per million input tokens and USD 10 per million output tokens: https://platform.claude.com/docs/en/about-claude/pricing

The configured per-chat token budgets represent approximately USD 0.20 per fully consumed chat at those rates, or USD 30 / USD 60 for the two monthly chat allowances. Token counting is an estimate; actual provider billing remains authoritative. This excludes taxes, hosting, payment fees, support and other services. Unknown provider usage is estimated conservatively rather than counted as free.

New-sale MRR is 9,990 * Form + 29,900 * Professional + 59,800 * Professional Plus HUF. Grandfathered Professional accounts contribute their actual retained Stripe price.

## Rollout

1. Deploy the additive database migration before API/worker code. It expires pre-rollout active chats; the worker persists their farewell and releases unused holds. New chat counters start empty, without retroactive session counting. Historical token accounting stays intact.
2. Configure the documented limits in deployment variables. Existing explicit CONVERSATION_TTL_MINUTES values must be changed to 15; a new default does not override an existing value. Do not edit or commit secret-containing environment files.
3. Preserve old Professional Price IDs in STRIPE_PRICE_PROFESSIONAL_LEGACY. Preview with pnpm stripe:catalog. Against a test key only, run the catalogue script with --apply --test-only and --verify --test-only. Configure new Price IDs in the deployment environment.
4. Configure the Stripe Customer Portal for immediate prorated upgrades and renewal-time downgrades across all three plans. Verify legacy subscriptions, new checkouts, Plus upgrades, downgrades, invoices, and webhook replay in test mode.
5. Activate production prices separately after test verification. Monitor admission rejections, closure reasons, provider errors and actual token usage. Do not log patient message bodies or credentials.

Run the affected pnpm lint, check-types and test suites, and the isolated browser suite with pnpm --filter @bam/web exec playwright test --config playwright.chat.config.ts. Browser tests mock provider/API responses and do not spend AI credits.

### Verified test catalogue (2026-09-26)

The catalogue was applied and verified using `--apply --test-only --portal`, followed by `--verify --test-only --portal`. The optional `--portal` flag updates the existing default test portal to offer all three prices, immediate prorated upgrades, and scheduled downgrades when the amount decreases.

| Deployment variable              | Verified test value            |
| -------------------------------- | ------------------------------ |
| STRIPE_PRICE_STARTER             | price_1UFDVoGw0xE7YXKfL6dcuvDw |
| STRIPE_PRICE_PROFESSIONAL        | price_1UJzILGw0xE7YXKfxay1SGgF |
| STRIPE_PRICE_PROFESSIONAL_PLUS   | price_1UJzILGw0xE7YXKfqEnrIhjv |
| STRIPE_PRICE_PROFESSIONAL_LEGACY | price_1UFEABGw0xE7YXKfrUoG7G6C |

Verified default test portal: `bpc_1UCM1LGw0xE7YXKfk3PxSpX5`. These are test-mode identifiers only. Secret environment files were not changed; deployment configuration must select these values before testing checkout against the new catalogue. Production catalogue activation remains a separate rollout step.
