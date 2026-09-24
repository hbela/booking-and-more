# Production deployment tasklist

Staging R2 backup setup and manual restore evidence are recorded in
[staging backup and recovery](staging-backup-recovery.md). Scheduling and independent
secret recovery are still pending; staging evidence does not complete production gates.

**Scope update (2026-09-20):** production will start with a new empty database,
while existing staging data is preserved. Follow the
[environment decision](production-environment-decision.md) for setup and promotion.
The preserved-data conversion and test-billing transition tasks below apply only
to an environment containing existing data; mark them not applicable for empty
production after verifying it. The recorded server baseline currently describes
staging, so production identifiers and recovery evidence must be collected separately.

Status recorded: 2026-09-20. Execution details and baseline identifiers are in the
[release runbook](production-launch.md). Checked items represent completed work;
implementation completion does not mean production acceptance.

Launch scope: preserve accounts and bookings, admit up to five approved businesses
for seven days, require fresh live checkout, and keep public owner signup closed.
Recovery targets: at most one hour of lost data and service restored within four hours.
The application owner is the launch operator and incident contact.

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
- [x] Add ARM64 and x86 Linux image verification to CI; execution remains pending.
- [x] Install restic and stage backup/restore scripts and systemd units on the VPS.
- [x] Verify backup failure handling with four isolated Linux tests and add them to CI.

## 2. Owner inputs and launch arrangements

- [ ] Choose backup storage: existing R2 bucket `booking-for-all-bucket` with
      separate prefix `booking-and-more/production`, or another destination.
- [x] Complete [staging custom backup monitor rollout](backup-monitor.md): Cloudflare/Resend email rehearsal and both scheduled successes (2026-09-24, 15:00 and 15:30 Budapest) verified. Operator confirmed Sentry backup Cron deletion; VPS legacy pings disabled with a protected rollback copy. Staging's half-hourly timer remains active.
- [ ] Supply up to five approved owner email addresses through private configuration.
- [ ] Confirm monthly prices of 9,990 and 24,990 HUF and the intended AAM configuration.
- [ ] Confirm the production Stripe account and Billingo environment/document block.
- [ ] Set the maintenance window, seven-day cohort dates and actual support/incident contact.
- [ ] Publish and review terms/privacy information and approve the documented
      customer-data deletion and incident procedures.

Do not put credentials, encryption keys or customer details in this checklist.

## 3. Recovery and infrastructure gates

- [ ] Review firewall/Docker bindings and verify database/Redis isolation externally,
      including IPv6 if enabled; resolve the historical database exposure conclusively.
- [ ] Restrict SSH and Coolify administration to operator addresses or VPN access;
      verify access without disrupting unrelated applications on the shared VPS.
- [ ] Initialize the encrypted off-host backup repository and securely configure the timer.
- [ ] Back up configuration, authentication secrets and both distinct customer PII
      keys separately from the database; verify the operator can recover them.
- [ ] Enable 30-minute backups with seven-day full retention plus 30 daily copies.
- [ ] Observe two successful backups 30 minutes apart and record recoverable snapshot IDs/times.
- [ ] Exercise the missing-backup alert and confirm it arrives before backup age reaches one hour.
- [ ] Restore a selected backup into isolated PostgreSQL/Redis volumes with outbound
      customer email, live payments and invoicing disabled.
- [ ] Demonstrate complete recovery, including secrets, application startup and data
      validation, within four hours; record elapsed time and evidence.
      [Staging technical drill](staging-recovery-drill-2026-09-24.md) passed on
      2026-09-24 in 78.97 seconds, including application reads, synthetic encrypted
      data and queue recovery. Full acceptance remains open: independent secrets,
      configuration/image recovery and HTTPS/browser validation are unverified.
- [ ] Configure and test alerts for web/API availability, stale worker heartbeat,
      overdue/failed work, disk pressure, billing and invoicing failures; exclude customer details.

## 4. Release validation and rehearsal

- [ ] Review the implementation diff against deployed `4a19f82`, including every
      pending migration and formatting-only changes; exclude unrelated local files.
- [ ] Select and record the immutable release SHA and rollback image references.
- [ ] Obtain passing CI for that SHA: `pnpm format:check`, `pnpm lint`,
      `pnpm check-types`, `pnpm test`, `pnpm build`, `pnpm test:e2e`,
      `pnpm audit:prod`, migration drift and migrations from scratch.
- [ ] Build and start the actual Linux web/API/worker images on ARM64 and x86;
      verify readiness and record image references.
- [ ] Rehearse encryption against preserved data in isolation: interruption/repeat,
      wrong/missing keys, row counts, decryptability, tenant-separated matching,
      readable booking responses and notification/calendar paths.
- [ ] Verify unverified/disallowed owners are denied creation and checkout,
      approved verified owners succeed, and existing-owner checkout is guarded.
- [ ] Verify staff invitations and public patient booking remain functional.
- [ ] Exercise Stripe sandbox success, failed payment, cancellation, duplicate and
      out-of-order events, wrong-mode events, and invoicing retry behavior.
- [ ] Dry-run billing transition for every in-scope tenant; classify all references
      and pending work, verify trial history/accounts/bookings are preserved, and
      resolve unknown references before maintenance.
- [ ] Verify cross-tenant denial, simultaneous booking conflicts, Budapest DST
      boundaries and worker restart/recovery; review relevant skipped test coverage.
- [ ] Verify actual verification-email delivery and resend with the configured sender.
- [ ] Stage invite-only configuration, HTTPS origins and production billing settings;
      verify price mode/currency/interval/amount and webhook signing configuration.
- [ ] Rehearse the maintenance sequence and pre-reopening restore rollback.

**Entry gate:** complete sections 2–4 before production conversion. Keep onboarding
closed if any gate lacks evidence. Retain one API instance for this launch.

## 5. Maintenance cutover — execute in order

- [ ] Start the maintenance window and block new application writes.
- [ ] Stop API and worker writers; verify no old processes can resume automatically.
- [ ] Take a fresh off-host maintenance backup after writes stop; record its snapshot
      ID, timestamp, existing images and configuration recovery references.
- [ ] Apply the reviewed additive migration using the selected release tooling.
- [ ] Run PII dry-run, apply, finalize and verify commands from the runbook.
- [ ] Validate unchanged row counts, decryptability and matching; confirm targeted
      fields contain no plaintext and old normalized lookup values are cleared.
- [ ] Apply each reviewed tenant billing transition using test credentials; confirm
      encrypted archives, detached test mappings and preserved trial-use history.
- [ ] Confirm test billing events/jobs are quarantined, test-derived paid access is
      removed, and unrelated booking/notification work remains intact.
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

| Evidence                                                            | Reference                          |
| ------------------------------------------------------------------- | ---------------------------------- |
| Selected release SHA and passing CI run                             | Pending                            |
| Deployed image references and migration result                      | Pending                            |
| Maintenance backup and separate configuration/key recovery location | Pending; location only, no secrets |
| Restore drill result and total recovery time                        | Pending                            |
| Network and alert verification                                      | Pending                            |
| Encryption and per-tenant billing transition validation             | Pending; aggregate results only    |
| Deployed smoke checks and first purchase/invoice outcome            | Pending; no customer details       |
| Cohort dates, operator and incident record                          | Pending                            |
