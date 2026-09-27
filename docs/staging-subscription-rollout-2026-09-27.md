# Staging subscription and chat rollout

Target: existing Coolify application `zcskco80804ogk4gskwoso40`, branch `release/production-launch-2026-09-20`. This is the staging application at `app.booking.appointer.hu` / `api.booking.appointer.hu`, despite its historical Coolify environment label. Production activation is outside this rollout.

## Peach Seesaw Sandbox

Verified Stripe account: `acct_1U90I8GT7MbFlwt0` (Peach Seesaw Sandbox). These identifiers belong to staging, not the separate local tester sandbox.

| Setting                          | Value                          |
| -------------------------------- | ------------------------------ |
| BILLING_MODE                     | test                           |
| STRIPE_PRICE_STARTER             | price_1UKLC6GT7MbFlwt02E5DMnrq |
| STRIPE_PRICE_PROFESSIONAL        | price_1UKLC7GT7MbFlwt0bqN5ZPdM |
| STRIPE_PRICE_PROFESSIONAL_PLUS   | price_1UKLC8GT7MbFlwt0Rm4A3pBd |
| STRIPE_PRICE_STARTER_LEGACY      | price_1UE5ITGT7MbFlwt0ZHZLWf5t |
| STRIPE_PRICE_PROFESSIONAL_LEGACY | price_1UE5JoGT7MbFlwt0sY1LzBTu |

Verified monthly HUF prices: Form 9,990; Professional 29,900; Professional Plus 59,800. Customer Portal `bpc_1UCKAJGT7MbFlwt0AGOBTuHp` offers these prices with immediate prorated upgrades and scheduled downgrades. Existing subscription prices remain unchanged. Legacy Form and Professional price IDs remain recognizable by webhook and schedule processing.

## Runtime settings

| Setting                                 | Value |
| --------------------------------------- | ----: |
| CONVERSATION_TTL_MINUTES                |    15 |
| CONVERSATION_MAX_TURNS                  |    40 |
| PENDING_ACTION_TTL_SECONDS              |   300 |
| CHAT_MAX_OUTPUT_TOKENS                  |  1024 |
| CHAT_DAILY_LIMIT                        |    30 |
| CHAT_MONTHLY_LIMIT_PROFESSIONAL         |   150 |
| CHAT_MONTHLY_LIMIT_PROFESSIONAL_PLUS    |   300 |
| CHAT_MAX_MESSAGE_CHARACTERS             |   500 |
| CHAT_MAX_PATIENT_CHARACTERS             |  5000 |
| CHAT_MAX_INPUT_TOKENS_PER_CONVERSATION  | 80000 |
| CHAT_MAX_OUTPUT_TOKENS_PER_CONVERSATION |  4000 |
| CHAT_START_RATE_LIMIT                   |    10 |
| CHAT_MESSAGE_RATE_LIMIT                 |    20 |
| CHAT_SESSION_RATE_LIMIT                 |    10 |

The owner content limit is 10,000 Unicode code points per language, shared across company description, service descriptions and FAQ questions/answers. It requires no environment setting.

## Deployment

Use the existing staging resource and persistent database/Redis volumes. Preserve its credentials, domains, signing/encryption keys and integrations. The Compose migration service applies `20260926120000_chat_guardrails` before starting the new API and worker; this expires old active chats and starts chat counters empty. Take a fresh staging backup before deployment.

Verify the pushed commit's CI, deployed commit, migration state, API liveness/readiness, web health, runtime settings and worker health. Keep automatic deployment disabled so pushing the branch does not deploy before environment setup and checks are complete.
