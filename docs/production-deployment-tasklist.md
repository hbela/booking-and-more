# Production deployment tasklist

Staging R2 backup setup and manual restore evidence are recorded in
[staging backup and recovery](staging-backup-recovery.md). Scheduling and independent
secret recovery have passed on staging; staging evidence does not complete production gates.

**Scope update (2026-09-20):** production will start with a new empty database,
while existing staging data is preserved. Follow the
[environment decision](production-environment-decision.md) for setup and promotion.
The preserved-data conversion and test-billing transition tasks below apply only
to an environment containing existing data; they are marked _N/A for empty
production_ and need only a check that the new database holds zero legacy rows.
The recorded server baseline describes staging, so production identifiers and
recovery evidence must be collected separately.

Status recorded: 2026-09-20; **reviewed 2026-10-18**. Execution details and baseline
identifiers are in the [release runbook](production-launch.md). Checked items
represent completed work; implementation completion does not mean production acceptance.

Launch scope: a new, empty production stack; admit up to five approved businesses
for seven days, require fresh live checkout, and keep public owner signup closed.
Recovery targets: at most one hour of lost data and service restored within four hours.
The application owner is the launch operator and incident contact.

## What's next (2026-10-18)

Nothing in production exists yet: no Coolify `production` environment, volumes,
domains, keys or monitors. In order:

1. ~~**Turn CI green.**~~ Done 2026-10-18 in `0d54492`. Every push since 2026-10-05
   had failed at _Audit production dependencies_ on two high advisories, `sharp <0.35.5`
   (via `@sentry/nextjs`) and `source-map-js <1.2.2` (via vitest's postcss). The audit
   runs first, so every later step had been skipped for two weeks. Root overrides fixed
   both; the only other debt the unskipped steps found was Prettier formatting in four
   docs. [Run 39141167574](https://github.com/hbela/booking-and-more/actions/runs/39141167574)
   passed every step, including the ARM64 and x86 image checks.
2. **Owner decisions (section 2).** Backup destination is decided; still open: the approved owner emails,
   the three-tier prices, the live Stripe account and Billingo block, the cohort
   dates and the terms/privacy pages. Everything from section 3 onward waits on
   at least one of these.
3. **Create the production stack** per the environment decision: rename the current
   Coolify environment to `staging`, create `production` with new volumes, domains,
   auth secret and both PII keys. Then run the section 3 gates against it.
4. **Section 4 on the selected SHA**, then the reduced cutover in section 5.

## 1. Completed preparation

- [x] Record the existing Coolify resource, deployed revision, image IDs, domains,
      database/Redis volumes and deployed migration status.
- [x] Disable automatic push deployment for this application.
- [x] Implement customer PII encryption, tenant-scoped blind indexes, additive
      migration and resumable backfill/finalization commands.
- [x] Implement verified-email owner allowlist checks, verification delivery and resend UI.
- [x] Implement billing-mode checks and dry-run-first tenant billing transition.
- [x] Centralize web API-origin validation and implement worker heartbeat/progress checks.
- [x] Pass local formatting, lint, types, build, tests, browser checks, dependency
      audit, migration drift and isolated migration checks; record results in the runbook.
- [x] Add ARM64 and x86 Linux image verification to CI. Both jobs build, migrate an
      empty database and start every image on each push; last passed on `15956c2`.
- [x] Install restic and stage backup/restore scripts and systemd units on the VPS.
- [x] Verify backup failure handling with four isolated Linux tests and add them to CI.
- [x] Convert staging's existing data to encrypted PII. The 2026-10-17 restore test
      decrypted restored historical ciphertext with the vault keys (T6, 0 failures).
- [x] Automate staging checks: weekly booking/chat run (passed 2026-09-30, 10-07,
      10-14) and the Stripe Sandbox lifecycle suite; see the
      [automated test checklist](automated-test-checklist.md).

## 2. Owner inputs and launch arrangements

- [x] Choose production backup storage. **Decided 2026-10-18:** Cloudflare R2 on the
      existing account's free tier, in a **new bucket `bam-production-backups`** reached
      by an R2 API token scoped to that bucket alone. Not a prefix in
      `booking-for-all-bucket`: staging's credentials are shared with other projects,
      and a leak of them must not be able to delete production backups.
      Sizing: staging's repository was 36 MiB at the 2026-10-17 restore test, after
      three weeks of half-hourly backups under full retention, against the free tier's
      10 GB-month. The free tier is an allowance, not a cap. Usage past it is billed
      automatically, so a prune that silently stops working shows up as cost
      rather than as a refusal. Watch the bucket size in the daily cohort review.
      Backup monitoring stays on the existing Worker: register `bam-production` in
      `MONITOR_IDS` with its own token and seed its `armed_at` at activation
      ([backup monitor](backup-monitor.md), last section). No second Worker or cron.
      Accepted risk: backups and their monitor share one provider. The healthchecks.io
      heartbeat alerts from outside Cloudflare, but there is one off-host copy of the
      data. Revisit a second destination (e.g. a Hetzner Storage Box) once clinics depend on it.
- [x] Complete [staging custom backup monitor rollout](backup-monitor.md): Cloudflare/Resend email rehearsal and both scheduled successes (2026-09-24, 15:00 and 15:30 Budapest) verified. Operator confirmed Sentry backup Cron deletion; VPS legacy pings disabled with a protected rollback copy. Staging's half-hourly timer remains active.
- [ ] Supply up to five approved owner email addresses through private configuration.
- [x] Confirm the three monthly tiers and the intended AAM configuration, and create the
      live catalogue. **AAM confirmed 2026-10-25** from the NAV registration record, dated
      2026-09-21. The seller is a sole trader (egyéni vállalkozó), adószám `92310634-1-33`,
      who has elected subject exemption from VAT (alanyi adómentesség, code 2) and holds
      an EU VAT number. This matches the code: payment links are created with automatic
      tax off, prices are tax-unspecified, and Billingo is restricted to
      `BILLINGO_VAT_CODE=AAM`. Stripe Tax stays off and no tax rates are added. If annual
      revenue passes the subject-exemption limit, the exemption ends and the VAT
      configuration must change; the accountant tracks this.
      **Catalogue created and verified 2026-10-27** in live account `acct_1UU4xdL8y0mQzxRg`
      by `stripe:catalog --apply --portal`, using a restricted live key (delete it in
      the dashboard once done). `--verify --portal` reported all four checks valid. The prices are
      Form 9,990, Professional 29,900 and Professional Plus 59,800 HUF a month, tax
      unspecified:
      `STRIPE_PRICE_STARTER=price_1UUXMeL8y0mQzxRgrYKxKLvI`,
      `STRIPE_PRICE_PROFESSIONAL=price_1UUXMfL8y0mQzxRg2sNtz47v`,
      `STRIPE_PRICE_PROFESSIONAL_PLUS=price_1UUXMfL8y0mQzxRga1vKPW3j`.
      The default Customer Portal `bpc_1UVBKKL8y0mQzxRgdCpH7HtL` offers all three plans,
      with immediate prorated upgrades and downgrades at the end of the period, plus
      invoice history.
      Production has no legacy prices, so `STRIPE_PRICE_*_LEGACY` stays unset; both
      default to empty. Set all three prices in Coolify. `loadEnv` refuses to start without
      the first two, but **does not require `STRIPE_PRICE_PROFESSIONAL_PLUS`**: if it is
      missing, production starts and simply cannot sell that plan. That gap is in
      `packages/config/src/schema.ts`.
      Watch for the `.env` fallback: a fresh PowerShell window has none of these variables
      set, so the script silently loads `.env` and verifies the local _test_ account.
      Its prices have the same amounts, so every line still reads `valid`. Before trusting a
      result, check that the portal and price IDs contain `L8y0mQzxRg`.
- [ ] Confirm the production Stripe account and Billingo environment/document block.
      **Stripe account chosen 2026-10-24:** a new dedicated account, Booking-and-more
      `acct_1UU4xdL8y0mQzxRg`, rather than `acct_1PMXZAGzrhgSGwTy`
      ("MyConnectingAccount"). That older account is shared with the predecessor project,
      and the Stripe connector in the development environment is attached to its live mode.
      Payment flow: customers pay us directly; no Connect, no connected accounts.
      Business type: sole proprietorship under the legal name, with the adószám as the
      business tax ID and `hu_tin` on receipts. Payout bank account added; account
      verification submitted 2026-10-27. The live account was entered with
      "Don't copy anything" from the sandbox. Stripe also created sandboxes
      `acct_1UU4xnLXEsDQu3oh` and `acct_1UV9z8LDQJZ48JtH`, both unused, because staging
      keeps the Peach Seesaw Sandbox. Live keys must start `sk_live_` and come from this
      account. **Verification received 2026-10-27.** Connect checked on live: no platform
      profile, no connected accounts. Public details: trading name "Booking-and-More",
      statement descriptor "Booking and More" (plain Latin and naming the business, since
      an unrecognised descriptor invites disputes), support email set to the operator's
      address, and business website `https://booking.appointer.hu`.
      The restricted catalogue key has been deleted.
      Still open: the webhook endpoint, once the production API domain exists; and all of
      Billingo.
- [ ] Decide the production domains. **Public site: `booking.appointer.hu`** (decided
      2026-10-27; it is also the website registered with Stripe). Before the first live
      charge it must show the three plans and their prices, contact details, and links
      to terms, privacy and cancellation/refund pages. Stripe's review and card-network
      dispute handling check exactly those. Production **app** and
      **API** hostnames **decided 2026-10-27: staging moves first.** Staging goes to
      `staging-app.booking.appointer.hu` / `staging-api.booking.appointer.hu`, and
      production then takes `app.booking.appointer.hu` / `api.booking.appointer.hu`.
      Runbook: [staging domain move](staging-domain-move.md). **Staging moved 2026-10-27**
      (live suite passed on the new names); its Stripe webhook and Sentry monitor are still to repoint.
- [ ] Set the maintenance window, seven-day cohort dates and actual support/incident contact.
- [ ] Publish and review terms/privacy information and approve the documented
      customer-data deletion and incident procedures. They must be live on
      `booking.appointer.hu` (above).

Do not put credentials, encryption keys or customer details in this checklist.

## 3. Recovery and infrastructure gates

All of these are for the **new production resource**. Staging evidence below shows
the procedure works; it does not satisfy the gate.

- [ ] Review firewall/Docker bindings and verify database/Redis isolation externally,
      including IPv6 if enabled; resolve the historical database exposure conclusively.
- [ ] Restrict SSH and Coolify administration to operator addresses or VPN access;
      verify access without disrupting unrelated applications on the shared VPS.
- [ ] Initialize the encrypted off-host backup repository and securely configure the timer.
      **Repository done 2026-10-22; timer pending** (Part B, needs the production stack).
      Restic repository `48985bdc` (format version 2) at
      `bam-production-backups/booking-and-more`, on a bucket-scoped Account API token.
      Credentials sit in the files `bam-backup@production.service` will load:
      `/etc/bam/production-restic.password`, `/etc/bam/production-r2-access-key` and
      `/etc/bam/production-r2-secret-key`, root-only. The password and both keys are in KeePassXC.
      Following the [initialise-and-test guide](guides/init-and-test-repo.md), a test file
      was backed up and restored byte-identical. Deleting its snapshot and then
      `restic prune` (2 packs, 1 index file) proved the token can delete, which retention
      needs. `restic check` found no errors, and the repository is empty again.
      Still to do: `/etc/bam/production-backup.conf` with the new compose project, the
      empty `production-backup-monitor-url` and the monitor token, then the timer.
- [ ] Back up configuration, authentication secrets and both distinct customer PII
      keys separately from the database; verify the operator can recover them.
      Staging's keys are in the operator's KeePassXC vault and were recovered from it
      in the 2026-09-24 and 2026-10-17 drills; production's keys must be added separately.
- [ ] Enable 30-minute backups with seven-day full retention plus 30 daily copies.
- [ ] Observe two successful backups 30 minutes apart and record recoverable snapshot IDs/times.
- [ ] Exercise the missing-backup alert and confirm it arrives before backup age reaches one hour.
      Production needs its own `bam-production` monitor ID and token in the backup
      monitor Worker. Staging silence, failure and overrun alerts passed on 2026-09-24,
      and the healthchecks.io heartbeat that watches the monitor itself passed on 2026-10-16.
- [ ] Restore a selected backup into isolated PostgreSQL/Redis volumes with outbound
      customer email, live payments and invoicing disabled.
      Staging evidence, 2026-10-17: the [monthly restore test](staging-db-restore-test-plan.md)
      passed all 13 checks. That covered recovery point, schema drift, per-table
      content hashes, historical ciphertext, behaviour on restored data, an old
      daily copy, the script's refusals and a full repository read. It is staging
      evidence only; production needs its own run against its own repository.
- [ ] Demonstrate complete recovery, including secrets, application startup and data
      validation, within four hours; record elapsed time and evidence.
      [Staging technical drill](staging-recovery-drill-2026-09-24.md) passed on
      2026-09-24 in 78.97 seconds, including application reads, synthetic encrypted
      data and queue recovery. The vault-sourced rerun passed in 79.21 seconds;
      Restic/R2 credentials, the authentication secret and both PII keys were verified.
      [Independent images and clean-host recovery](staging-clean-host-recovery-2026-09-25.md)
      and HTTPS/browser validation passed on 2026-09-25; drill resources were removed.
      Software provisioning through browser validation took 2h10m including DNS wait.
      Full production acceptance remains open: manual VPS creation/SSH setup was
      outside that timer, and representative production data/configuration was not tested.
- [ ] Configure and test alerts for web/API availability, stale worker heartbeat,
      overdue/failed work, disk pressure, billing and invoicing failures; exclude customer details.
      State on staging ([monitoring setup](monitoring-setup.md)):
  - [x] API `/health/ready` Sentry uptime monitor (covers PostgreSQL and Redis).
  - [x] Worker heartbeat Sentry cron; stopping the worker alerted the operator (2026-10-12).
  - [ ] Stuck/failed work reported through the same heartbeat — built, never provoked end to end.
  - [ ] Web `/api/health` check — not configured; the Sentry free plan allows one uptime monitor.
  - [ ] Disk pressure, billing and invoicing failure alerts — not wired.
  - [ ] Production Sentry environment, separate monitors, and a repeat of the heartbeat test.

## 4. Release validation and rehearsal

- [x] **Restore passing CI on the release branch** (see _What's next_ step 1).
- [ ] Review the release diff, including every pending migration and formatting-only
      changes; exclude unrelated local files. Production deploys onto an empty
      database, so the diff that matters for data is staging's: it last recorded
      `8633c0d` (2026-09-28) and has since run at least `2d202e6` (worker heartbeat
      verified 2026-10-12). Confirm the current staging revision in Coolify.
- [ ] Select and record the immutable release SHA and rollback image references.
- [ ] Obtain passing CI for that SHA: `pnpm format:check`, `pnpm lint`,
      `pnpm check-types`, `pnpm test`, `pnpm build`, `pnpm test:e2e`,
      `pnpm audit:prod`, migration drift and migrations from scratch.
- [ ] Build and start the actual Linux web/API/worker images on ARM64 and x86;
      verify readiness and record image references. CI does this on every push and
      it passes; record the run for the selected SHA.
- [ ] _N/A for empty production._ Rehearse encryption against preserved data in
      isolation. Staging was already converted (section 1); for production, verify
      zero legacy plaintext rows after migrating and that the first new customer
      write is encrypted.
- [ ] Verify unverified/disallowed owners are denied creation and checkout,
      approved verified owners succeed, and existing-owner checkout is guarded.
- [ ] Verify staff invitations and public patient booking remain functional.
      Public booking and cancellation pass weekly against staging; staff invitations
      have no automated staging check.
- [ ] Exercise Stripe sandbox success, failed payment, cancellation, duplicate and
      out-of-order events, wrong-mode events, and invoicing retry behavior.
      Done on staging 2026-09-28 (five lifecycle scenarios, plus the same-second
      ordering fix): success, failed renewal, cancellation, duplicate/out-of-order,
      upgrades and scheduled downgrades. **Still open:** wrong-mode events, Billingo
      invoicing retry, and hosted Checkout completion by hand.
- [ ] _N/A for empty production._ Dry-run billing transition for every in-scope tenant.
      Verify the production database has no tenants before the cohort is admitted.
- [ ] Verify cross-tenant denial, simultaneous booking conflicts, Budapest DST
      boundaries and worker restart/recovery; review relevant skipped test coverage.
      Cross-tenant access and slot conflicts are covered by isolated-database tests
      (once CI runs them again); DST and worker restart have no recorded check.
- [ ] Verify actual verification-email delivery and resend with the configured sender.
- [ ] Stage invite-only configuration, HTTPS origins and production billing settings;
      verify price mode/currency/interval/amount and webhook signing configuration.
- [ ] Rehearse the maintenance sequence and pre-reopening restore rollback. For empty
      production this reduces to: deploy, migrate, smoke-test while closed, and
      tear down and recreate if it fails — rehearse that on a throwaway stack.

**Entry gate:** complete sections 2–4 before opening production. Keep onboarding
closed if any gate lacks evidence. Retain one API instance for this launch.

## 5. Maintenance cutover — execute in order

Written for converting a database that holds data. For the **empty production stack**
the steps marked _N/A_ are replaced by the zero-legacy-rows check; nothing is open
to the public yet, so "maintenance" means keeping the new domains closed.

- [ ] Start the maintenance window and block new application writes.
- [ ] Stop API and worker writers; verify no old processes can resume automatically.
- [ ] Take a fresh off-host maintenance backup after writes stop; record its snapshot
      ID, timestamp, existing images and configuration recovery references.
- [ ] Apply the reviewed additive migration using the selected release tooling.
- [ ] _N/A for empty production._ Run PII dry-run, apply, finalize and verify
      commands from the runbook. Run `--verify` only, expecting zero rows.
- [ ] _N/A for empty production._ Validate unchanged row counts, decryptability and
      matching; confirm targeted fields contain no plaintext and old normalized
      lookup values are cleared.
- [ ] _N/A for empty production._ Apply each reviewed tenant billing transition using
      test credentials; confirm encrypted archives, detached test mappings and
      preserved trial-use history.
- [ ] _N/A for empty production._ Confirm test billing events/jobs are quarantined,
      test-derived paid access is removed, and unrelated booking/notification work
      remains intact.
- [ ] Switch API and worker together to verified live billing configuration and
      invite-only access; require fresh checkout, with no automatic charges.
- [ ] Start the selected release while keeping public access in maintenance.
- [ ] Smoke-test deployed HTTPS health, sign-in, permissions, owner gating,
      booking/cancellation, reminders, multilingual chat, embedded booking and PWA/QR flows.
- [ ] Verify worker progress, monitoring and scheduled backups on the new deployment.
- [ ] Record all gate evidence and rollback references, then reopen for the approved cohort.

**Rollback boundary:** never start pre-encryption code against converted data.
Before reopening, restore the maintenance backup if conversion fails. After reopening,
use an encryption-compatible release or a deliberate recovery operation that reconciles
subsequent bookings/payments. A database restore does not reverse external billing actions.

## 6. Seven-day cohort and completion

- [ ] Onboard no more than five approved, email-verified business owners.
- [ ] Observe the first genuine live purchase; verify paid access and the correct
      invoice without generating an artificial live test charge.
- [ ] Confirm each business can book/cancel appointments and receive notifications.
- [ ] Review uptime, worker delays/failures, billing/invoicing, backups and disk daily.
- [ ] Log and resolve incidents and all critical defects throughout the seven days.
- [ ] Confirm recovery targets remain demonstrated and all launch evidence is recorded.
- [ ] Record cohort completion and an explicit separate decision before opening public signup.

## Evidence to record at completion

| Evidence                                                            | Reference                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| Selected release SHA and passing CI run                             | Pending                                                     |
| Deployed image references and migration result                      | Pending                                                     |
| Maintenance backup and separate configuration/key recovery location | Pending; location only, no secrets                          |
| Restore drill result and total recovery time                        | Pending                                                     |
| Network and alert verification                                      | Pending                                                     |
| Encryption and per-tenant billing transition validation             | N/A for empty production; record the zero-legacy-rows check |
| Deployed smoke checks and first purchase/invoice outcome            | Pending; no customer details                                |
| Cohort dates, operator and incident record                          | Pending                                                     |
