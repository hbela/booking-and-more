# Staging domain move

Decided 2026-10-27: staging gives up `app.booking.appointer.hu` and
`api.booking.appointer.hu` so production can take them, and moves to:

| Role | Now                                | After                                      |
| ---- | ---------------------------------- | ------------------------------------------ |
| Web  | `https://app.booking.appointer.hu` | `https://staging-app.booking.appointer.hu` |
| API  | `https://api.booking.appointer.hu` | `https://staging-api.booking.appointer.hu` |

The public site `booking.appointer.hu` belongs to production
([tasklist §2](production-deployment-tasklist.md)). Staging data, volumes, keys and
billing (Peach Seesaw Sandbox) are untouched. Only the names change.

## Status (2026-10-27)

Steps 1–3, 7 and 8 are done; **4–6 are still open**.

- **DNS:** nothing to add. A wildcard A record `*.booking.appointer.hu` already resolves
  both new names to the VPS (116.203.205.166), as it does the old ones.
- **Coolify:** domains and `APP_BASE_URL`/`API_BASE_URL` switched, and the web rebuilt.
  Let's Encrypt certificates for both names were issued 16:19 UTC; their chain runs YR1 →
  Root YR → ISRG Root X1. A Windows `curl` (schannel) refused the chain on its first
  attempt and accepted it on the next; `openssl` verified it throughout.
- **Verified:** `staging-api…/health/ready` and `staging-app…/api/health` return 200. The
  web CSP's `connect-src` names `https://staging-api.booking.appointer.hu`, which proves
  the rebuilt bundle. CORS preflight allows the new web origin and refuses the old one.
  The old names now answer `503 no available server`.
- **Repository:** `ff824ea` updated the live-test targets, the demo sites, and current docs.
  The demo-sites e2e passed, 20 of 20.
- **Live suite by hand:**
  [run 40549532758](https://github.com/hbela/booking-and-more/actions/runs/40549532758)
  on `ff824ea`: preflight, booking/cancellation and chat, 3 passed.
- **Open, and both are failing right now:** the Stripe sandbox webhook (step 4) still targets
  the old API name, so sandbox events are not delivered until it moves. Stripe retries for
  up to three days. The Sentry uptime monitor (step 5) still probes the old name, which
  answers 503 and will alert. Step 6 applies only if Google sign-in is configured.

## What the move does and does not need

**No application code change.** Every origin check derives from two settings: the
API's CORS allow-list (`apps/api/src/app.ts`), Better Auth's `trustedOrigins`
(`packages/auth/src/auth.ts`) and the web CSP's `connect-src`
(`apps/web/src/lib/security-headers.ts`). The two settings are `APP_BASE_URL` and
`API_BASE_URL`. Change them and the application follows.

**But the web image must be rebuilt.** `NEXT_PUBLIC_API_BASE_URL` comes from
`API_BASE_URL` and is compiled into the browser bundle. A restart with new variables
leaves every browser calling the old API host. The API and worker only need a redeploy.

**What breaks, by design.** Anything already holding an old staging URL:

- links in emails staging has sent, such as invitations, booking management and payment links;
- staging PWAs installed on phones, which are bound to their origin and must be reinstalled;
- signed-in sessions, whose cookies are host-bound, so everyone signs in again;
- bookmarks.

It is staging, so these are tolerated rather than redirected. A redirect from the old
names is impossible anyway, because production is about to own them.

## Timing

The scheduled **Staging live tests** run Wednesdays at 05:30 UTC (GitHub starts them hours
late) and target the hostnames hard-coded in the repo. Do the switch so that the repo
commit (step 7) lands **the same day as** the infrastructure change, and not on a
Tuesday night. Otherwise the weekly run tests a hostname that is not serving.

## Steps

1. **DNS.** Add A records `staging-app.booking` and `staging-api.booking` under
   `appointer.hu`, pointing at the VPS's public IPv4, the same target as today's
   `app.booking` and `api.booking`. Add AAAA only if the VPS routes IPv6. Leave the old
   records in place: production reuses them (the same VPS).
2. **Coolify, staging resource `zcskco80804ogk4gskwoso40`.**
   - Set the web service domain to `https://staging-app.booking.appointer.hu` and the API
     service domain to `https://staging-api.booking.appointer.hu`. Each must agree
     exactly with the variables below; the compose file's `SERVICE_FQDN_*` comments
     explain why.
   - Set `APP_BASE_URL=https://staging-app.booking.appointer.hu` and
     `API_BASE_URL=https://staging-api.booking.appointer.hu`.
   - **Take a staging backup first** (`systemctl start bam-backup@staging.service`), as
     for any staging deployment.
   - Redeploy **with a rebuild** of the web image. Wait for certificates to be issued for
     both new names.
3. **Verify the new names.**
   - `https://staging-api.booking.appointer.hu/health/ready` returns 200.
   - `https://staging-app.booking.appointer.hu/api/health` returns 200.
   - Sign-in works in Hungarian and English. In the browser's network tab, API calls go to
     `staging-api.…` with no CORS errors.
   - The old names no longer serve staging. Once Coolify releases them, Traefik answers
     with its default 404 or a certificate error.
4. **Stripe (Peach Seesaw Sandbox, `acct_1U90I8GT7MbFlwt0`).** Change the webhook
   endpoint URL to the new API host, keeping its path and events. Changing only the URL
   keeps the signing secret, so `STRIPE_WEBHOOK_SECRET` stays as it is. Send a test event
   and confirm it is delivered with a 2xx response.
5. **Sentry uptime monitor `2413672`.** Point it at
   `https://staging-api.booking.appointer.hu/health/ready`.
6. **Google OAuth, only if `GOOGLE_CLIENT_ID` is set on staging.** Add the new origin and
   the new redirect URI in the Google console. Otherwise skip this step.
7. **Repository**, in one commit after step 3 passes:
   - `apps/web/e2e-live/fixtures.ts` (`appOrigin`, `apiOrigin`)
   - `apps/web/playwright.live.config.ts` and `apps/web/playwright.staging.config.ts`
     (`baseURL`)
   - `demo/wellness/**`, `demo/medicare/**` and `demo/README.md`: the demo sites are
     staging demos and must follow staging. They deploy from their own Coolify resources,
     and `wellness-demo` has auto-deploy on, so check its source branch.
   - Docs that name staging's current hostnames: [monitoring setup](monitoring-setup.md),
     [staging live tests](staging-live-tests.md),
     [organization mobile apps](guides/organization-mobile-apps.md). Leave historical
     records (drills, rollouts, the 2026-09-20 baseline) as they are: they describe what
     was true then.
   - Mocked browser tests and unit tests that use `app.booking.appointer.hu` as an
     example origin (`e2e/patient-qr.spec.ts`, `e2e/demo-sites.spec.ts`,
     `src/lib/tenant-pwa.test.ts`) mock their own responses and never contact it. Update
     `demo-sites.spec.ts` with the demo pages, because it asserts their links; the others
     can stay.
8. **Run the live suite once by hand** against the new names: the preflight first, then
   booking and chat ([staging live tests](staging-live-tests.md)), so the scheduled run
   is not the first proof.

## After the move

Production can then claim `app.booking.appointer.hu` and `api.booking.appointer.hu`
when its stack is created ([environment decision](production-environment-decision.md)).
Until then those names serve nothing.
