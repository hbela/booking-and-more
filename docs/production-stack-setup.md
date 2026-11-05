# Production stack setup

Written 2026-11-03. The step-by-step for tasklist item 3, "Create the production
stack", following the [environment decision](production-environment-decision.md).
The general walkthrough is [phase 10](phase-10-deployment-hetzner-coolify.md); this
page is the production-specific list, so it can be done in one pass.

**No secret value appears here.** Each secret is named, with where it comes from;
the value goes from KeePassXC (or from the generator) straight into Coolify.

## 1. Before Coolify: generate the new secrets

Generate these on your own machine, in Git Bash, and save each one in KeePassXC
**before** pasting it anywhere. They are production's own; never copy staging's.

| KeePassXC entry                | Command                   | Why this form                                                          |
| ------------------------------ | ------------------------- | ---------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`            | `openssl rand -hex 32`    | Goes into a URL. Base64's `/` breaks it (phase-10 §2.9)                |
| `REDIS_PASSWORD`               | `openssl rand -hex 32`    | Same                                                                   |
| `BETTER_AUTH_SECRET`           | `openssl rand -base64 32` | Write-once: rotating it signs everybody out                            |
| `CUSTOMER_PII_ENCRYPTION_KEY`  | `openssl rand -hex 32`    | Losing it loses the encrypted customer data. Must differ from the next |
| `CUSTOMER_PII_BLIND_INDEX_KEY` | `openssl rand -hex 32`    | Generate separately; the config refuses two equal keys                 |

Also create, each in its own service, a **production-only** key, and save it:

- **Resend:** a new API key with _Sending access_ only, restricted to the verified
  domain staging already sends from. A separate key lets you revoke one environment
  without the other.
- **Anthropic** (only if Professional plans are sold at launch, since they include
  the AI chat): a new API key in its own workspace with a monthly spend limit.

Already in KeePassXC: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (2026-11-03),
and the live `BILLINGO_API_KEY`.

## 2. Coolify: environments and the resource

1. In the `booking-and-more` project, **rename the environment `production` to
   `staging`**. It holds the staging resources; renaming changes no container, volume
   or domain. Check the project's shared variables first: a shared variable follows the
   environment it is defined in.
2. **Create a new environment `production`.**
3. In it, **add a new resource** from the same GitHub repository. Do not clone the
   staging resource: a clone copies its variables and domains, which is exactly what
   must not be shared.
   - Branch: `release/production-launch-2026-09-20`, the branch staging runs. Deploy a
     specific commit (the one staging has validated), not "latest".
   - Build pack: Docker Compose, location `/docker-compose.coolify.yml`, base
     directory `/`.
   - **Automatic deployment: off.** Production is promoted by hand (decision §9).
4. **Domains** (on the services, not in the variables screen; phase-10 §5.5):
   - `web`: `https://app.booking.appointer.hu,https://booking.appointer.hu`
   - `api`: `https://api.booking.appointer.hu`

   The A records `app.booking` and `api.booking` already exist (they served staging
   before 2026-10-27). Add one for **`booking`** under `appointer.hu`, pointing at the
   same VPS. The wildcard does not cover it.

## 3. The variables

Enter these in the new resource's **Environment Variables**. Coolify lists a field for
every variable the compose file names; anything not in these tables stays **empty**,
which the config treats as "not configured".

### 3.1 Secrets: from KeePassXC

| Variable                       | Source                                  |
| ------------------------------ | --------------------------------------- |
| `POSTGRES_PASSWORD`            | Generated in §1                         |
| `REDIS_PASSWORD`               | Generated in §1                         |
| `BETTER_AUTH_SECRET`           | Generated in §1                         |
| `CUSTOMER_PII_ENCRYPTION_KEY`  | Generated in §1                         |
| `CUSTOMER_PII_BLIND_INDEX_KEY` | Generated in §1                         |
| `STRIPE_SECRET_KEY`            | Live `sk_live_…`, created 2026-11-03    |
| `STRIPE_WEBHOOK_SECRET`        | `whsec_…` of the production endpoint    |
| `BILLINGO_API_KEY`             | The live Billingo account's key         |
| `RESEND_API_KEY`               | The production-only key from §1         |
| `ANTHROPIC_API_KEY`            | The production-only key, or leave empty |

### 3.2 Plain settings: not secret

| Variable                         | Value                                                                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_BASE_URL`                   | `https://app.booking.appointer.hu`                                                                                                                         |
| `API_BASE_URL`                   | `https://api.booking.appointer.hu`                                                                                                                         |
| `BILLING_MODE`                   | `live`                                                                                                                                                     |
| `LAUNCH_ACCESS_MODE`             | `invite_only`                                                                                                                                              |
| `LAUNCH_OWNER_EMAIL_ALLOWLIST`   | The approved owners' addresses, comma-separated. **Required even for provisioned owners**: the payment link is refused without it (onboarding record §2.4) |
| `EMAIL_FROM`                     | The same sender as staging's `EMAIL_FROM`, on the verified domain                                                                                          |
| `STRIPE_PRICE_STARTER`           | `price_1UUXMeL8y0mQzxRgrYKxKLvI`                                                                                                                           |
| `STRIPE_PRICE_PROFESSIONAL`      | `price_1UUXMfL8y0mQzxRg2sNtz47v`                                                                                                                           |
| `STRIPE_PRICE_PROFESSIONAL_PLUS` | `price_1UUXMfL8y0mQzxRga1vKPW3j`                                                                                                                           |
| `BILLINGO_BASE_URL`              | `https://api.billingo.hu/v3`                                                                                                                               |
| `BILLINGO_BANK_ACCOUNT_ID`       | `298836`                                                                                                                                                   |
| `BILLINGO_DOCUMENT_BLOCK_ID`     | `344906` (never `344907`, the receipt block)                                                                                                               |
| `BILLINGO_VAT_CODE`              | `AAM`                                                                                                                                                      |
| `SENTRY_DSN`                     | Same API project DSN as staging                                                                                                                            |
| `WEB_SENTRY_DSN`                 | Same web project DSN as staging                                                                                                                            |
| `SENTRY_ENVIRONMENT`             | `production`                                                                                                                                               |
| `CANONICAL_REDIRECT_HOSTS`       | `booking.appointer.hu`                                                                                                                                     |
| `LEGAL_NAME`                     | Your choice of what the impresszum shows (public-site record §2.1)                                                                                         |
| `LEGAL_ADDRESS`                  | Same                                                                                                                                                       |
| `LEGAL_TAX_NUMBER`               | Same                                                                                                                                                       |
| `LEGAL_EU_VAT_NUMBER`            | Same                                                                                                                                                       |
| `LEGAL_REGISTRATION_NUMBER`      | Same                                                                                                                                                       |
| `LEGAL_EMAIL`                    | The support address; it is also the "Contact us" button's target                                                                                           |

The `LEGAL_*` values are public once the page renders, but they are personal, so they
live in Coolify and KeePassXC, never in the repository.

### 3.3 Leave empty or at their defaults

- `POSTGRES_USER`, `POSTGRES_DB`, `LOG_LEVEL`, every `CHAT_*`, `CONVERSATION_*`,
  `KNOWLEDGE_*`, `PROMPT_*`, `PENDING_ACTION_TTL_SECONDS` and `ANTHROPIC_CHAT_MODEL`:
  the compose defaults are the tested values.
- `TRIAL_PERIOD_DAYS`, `ONBOARDING_WINDOW_DAYS`, `INVITATION_EXPIRY_HOURS`,
  `BOOKING_REMINDER_LEAD_HOURS`: the schema defaults. The pricing page advertises a
  30-day trial, so leave `TRIAL_PERIOD_DAYS` alone.
- `STRIPE_PRICE_*_LEGACY`: production has no legacy prices.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: the calendar integration is parked.
- `SERVICE_FQDN_*`: Coolify fills these from the domains.
- `SENTRY_ORG` and the `SENTRY_AUTH_TOKEN` build secret: only for source-map upload.
  Set them as staging has them, or leave them empty; errors are reported either way.

**Sentry is shared with staging.** Both environments report to the same two projects,
told apart by `SENTRY_ENVIRONMENT`, and they share the free plan's monthly error
allowance. The per-runtime daily cap (monitoring setup) keeps one from starving the
other.

### 3.4 What the config refuses at boot

So that a typo shows up as a clear failed deployment rather than a half-working app:

- `BILLING_MODE=live` with a key that does not start `sk_live_`.
- A Stripe key without the webhook secret or any of the three price IDs.
- Some but not all of the five `BILLINGO_*` values.
- `invite_only` without `RESEND_API_KEY` and `EMAIL_FROM`, since owners must verify email.
- The two PII keys equal; a password containing `/`.

## 4. First deployment and checks

1. Deploy. The `migrate` service applies every migration to the empty database and
   exits; `api`, `worker` and `web` start after it.
2. Check, from your machine:
   - `https://api.booking.appointer.hu/health/ready` answers `200`.
   - `https://app.booking.appointer.hu/api/health` answers `200`.
   - `curl -s -o /dev/null -w "%{http_code}" -X POST https://api.booking.appointer.hu/v1/webhooks/stripe`
     answers `401` ("Missing Stripe signature"): the route is up and refuses an
     unsigned body. A `404` means Stripe is not configured and the route was not
     registered.
   - `curl -sI https://booking.appointer.hu/en/pricing` answers `308` to
     `https://app.booking.appointer.hu/en/pricing`.
   - The home page shows the impresszum footer with the `LEGAL_*` values.
3. **Your platform-admin account.** Sign up at `/sign-up` with an address that will
   never own a clinic, verify the email (this proves Resend works), then in Coolify
   open a terminal on the **api** container:

   ```bash
   cd /app/packages/db && ./node_modules/.bin/tsx ./scripts/grant-platform-admin.ts <your address>
   ```

   Rule 9: this account holds no memberships, so use a second address for any
   clinic-side test.

4. Verify the database is empty apart from that user: no tenants, no legacy rows
   (tasklist §4).

Then continue with the tasklist's section 3 against this new resource: the backup
timer (Part B: `/etc/bam/production-backup.conf` with this resource's compose project
and volume names), key recovery, the restore drill, the two UptimeRobot monitors
(`app.booking.appointer.hu/api/health` and `api.booking.appointer.hu/health/ready`),
the Sentry worker cron for the `production` environment, and the heartbeat test.
