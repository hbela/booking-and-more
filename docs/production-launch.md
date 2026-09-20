# First paying cohort: release runbook

Track execution in the [production deployment tasklist](production-deployment-tasklist.md).

**Updated deployment decision (2026-09-20):** the existing server application is
staging. The owner chose a new, empty production database; preserve staging data.
See the [environment decision](production-environment-decision.md), which supersedes
the in-place production conversion assumptions below. Existing-data conversion
steps still apply when upgrading staging, but are not needed for empty production.

This runbook preserves the existing Coolify resource and its PostgreSQL/Redis
volumes. It does **not** assert that the server is production-ready. Do not reopen
onboarding until the evidence below is filled in. Target: at most one hour of
lost data and four hours to restore service, including recovering secrets.

## Release evidence

| Gate          | Evidence required                                                                                                  | Status                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Baseline      | Running SHA, selected SHA, image digests, domains, resource ID, volume IDs, migration status, deployment trigger   | Baseline recorded; release pending      |
| CI            | Passing selected-SHA workflow, including Linux image build/start verification                                      | Pending                                 |
| Network       | Off-host scan; HTTPS works, 5432/6379 closed; SSH and Coolify admin restricted                                     | Partial; management/IPv6 review pending |
| Recovery      | Off-host snapshot ID/time, restored isolated database, recovered keys, timed application checks under four hours   | Pending                                 |
| Billing       | Live account ID, both live prices, webhook secret/mode, Billingo production document block/VAT, owner confirmation | Pending                                 |
| Legal/support | Published terms/privacy, actual support contact, retention/deletion procedure reviewed by owner                    | Pending                                 |
| Cohort        | Up to five approved verified owner emails; seven-day observation dates                                             | Pending                                 |

Record identifiers and timestamps here, never credentials, backup contents, or
customer details. The baseline below was verified directly on the server.
Preserve unrelated `.claude/` and `.commandcode/` files outside the release.

### Verified baseline: 2026-09-20

- Coolify resource `zcskco80804ogk4gskwoso40`, application 19, `booking-and-more:main`.
  Latest successful deployment: `4a19f82a4b5b4a39558b84e685449dec07d9c8b3`,
  recorded at `2026-09-19 18:45:19`. Compose path: `/docker-compose.coolify.yml`.
  Automatic push deployment was disabled and read back as disabled.
- Web: `https://app.booking.appointer.hu`; API: `https://api.booking.appointer.hu`.
  Web health, API liveness/readiness, and Hungarian/English sign-in returned HTTP 200.
- Production is ARM64. CI now includes both ARM64 and x86 Linux image checks;
  these checks have not yet run for the selected release.
- PostgreSQL volume: `zcskco80804ogk4gskwoso40_postgres-data`;
  Redis volume: `zcskco80804ogk4gskwoso40_redis-data`.
  The running application reports 41 applied migrations with no pending migrations
  in its deployed schema. The new encryption migration has not run in production.
- Running image IDs (retain before maintenance):
  API `sha256:1af8f6778bc539fe047131b8e9f5745c1cdefe133b7188f5866b0b35dfcec69c`;
  worker `sha256:e8cba37e25207535cd07fdad2927df360f6a6085772304db2e3c4574837b77af`;
  web `sha256:388c526e16ad5489f270335d8a18e11a314cb83076e2fc987edf525d40602cd0`.
- An external IPv4 probe reached ports 22/80/443; ports 5432/6379/8000/8080
  timed out. This does not prove IPv6 coverage or restricted management access.
  The VPS hosts unrelated applications; one unrelated database proxy binds 5432.
  Review firewall rules before declaring the network gate passed.
- API and worker currently use Stripe test keys. Mail and Billingo settings exist,
  but successful delivery and production Billingo configuration remain unverified.
- Coolify has no scheduled database backups. Restic 0.16.4 and the backup/restore
  scripts and systemd units are staged on the host; the timer remains disabled.
  The off-host repository, monitor, separate key recovery and restore drill are pending.
  Existing R2 storage offers bucket `booking-for-all-bucket`; the proposed isolated
  prefix is `booking-and-more/production`, awaiting the operator's storage choice.

Local validation passed: formatting, lint, types, build, 1,616 tests, 49 browser
checks, production dependency audit, migration drift, and isolated migrations from
scratch. There are 49 skipped unit/integration tests, including parked calendar
coverage; these do not establish production calendar readiness. The recovery scripts
passed host shell syntax checks and the systemd units passed verification.
Four isolated Linux backup tests also passed, covering container selection,
failed dumps, storage failures and heartbeat ordering. They mock external services;
they do not demonstrate backup recoverability. Docker is unavailable on the local
development host, so actual image execution still requires the Linux CI runners.
These results do not replace selected-revision CI, Linux container execution,
deployed acceptance checks or recovery evidence. No production application/data
conversion or billing activation has occurred.

## Preparation and backups

1. Record the baseline in Coolify and disable push-triggered deployment. Require
   successful CI on the exact selected revision before manual promotion.
2. Verify the host firewall and Docker port bindings from another network. Keep
   the existing database/Redis ports private. Check the earlier database exposure
   is resolved, enable PostgreSQL connection logging without statement/PII logging,
   and restrict management access to operator addresses/VPN.
3. Install restic on the VPS and initialize an encrypted repository on storage
   outside the VPS. Keep its password and the PII/auth keys in a separately backed-up
   password manager. Do not rotate existing authentication keys during this release.
4. Install `ops/production/backup.sh` executable under `/opt/bam/ops/production`;
   install the matching systemd service/timer. Supply `/etc/bam/backup.env` with
   mode 0600: `POSTGRES_COMPOSE_PROJECT`, `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE`,
   provider-specific storage credentials and `BACKUP_MONITOR_URL`. The external
   dead-man monitor must alert at 50 minutes without success. Enable the timer
   and demonstrate two successful off-host backups 30 minutes apart.
   Set the compose project from the running database's Docker label; the script
   requires exactly one matching running PostgreSQL container on every execution.
   The verified production project label is `zcskco80804ogk4gskwoso40`.
5. Backups retain every snapshot for seven days and daily snapshots for 30 days.
   Monitor disk space at 80% warning/90% critical. A failed backup or retention
   operation does not send a success heartbeat. Measure duration; if it approaches
   25 minutes, reduce backup size or implement WAL archiving before launch.
   Only snapshots tagged `bam-production` are recoverable candidates. Failed dump
   attempts may leave `bam-pending-*` snapshots; investigate and remove those
   separately, never use them to satisfy the backup-age gate.
6. Restore a selected snapshot into an empty, isolated PostgreSQL 18 database
   named `bam_rehearsal_*` using `restore-rehearsal.sh`. Use separate Redis,
   disabled outgoing integrations, and restricted access to the restored PII.
   Verify row counts and application reads. Restoring a dump alone is not the
   four-hour recovery proof: time provisioning, secrets recovery and application
   validation too. Repeat the drill monthly.

## Application configuration and migration

New settings (inject through Coolify, never commit secret environment files):

- `CUSTOMER_PII_ENCRYPTION_KEY`, `CUSTOMER_PII_BLIND_INDEX_KEY`: distinct 64-hex
  values, independently generated with `openssl rand -hex 32`; required by API
  and worker. Securely preserve both before conversion. Losing them loses access
  to the encrypted fields or matching indexes.
- `LAUNCH_ACCESS_MODE=invite_only`; `LAUNCH_OWNER_EMAIL_ALLOWLIST` is a
  comma-separated set of approved owner emails, normalized to lowercase.
  An empty list admits no owners. Both creation and checkout check the current
  database verification state. Staff invitations and public booking remain available.
- `RESEND_API_KEY` and `EMAIL_FROM`: verified sending domain and functioning mail
  delivery required. Signup and resend use expiring Better Auth verification links.
- `BILLING_MODE=test` during rehearsal and test-billing transition; switch to
  `live` only with matching keys, prices, webhook configuration and owner confirmation.
- The web build requires `NEXT_PUBLIC_API_BASE_URL` to be a valid HTTPS origin.
  Coolify derives it from `API_BASE_URL`; rebuild the web image when it changes.

The migration adds nullable blind-index columns and an encrypted billing-transition
archive. It retains the old normalized columns temporarily. Runtime code writes
only encrypted customer fields/snapshots and blind indexes; it rejects plaintext
on reads. Therefore deployment must not start API/worker between schema migration
and completed conversion. The ordinary compose migration dependency alone is
insufficient for this release: keep the proxy in maintenance and API/worker stopped
while running the release migration container and the commands below.

From a secure source checkout of the selected revision (scripts are not in the
runtime image), install with the pinned pnpm version and build dependencies. With
the target environment injected and **both API and worker stopped**:

```sh
pnpm --filter @bam/db db:migrate:deploy
pnpm --filter @bam/api db:backfill-pii
pnpm --filter @bam/api db:backfill-pii --apply --maintenance --database EXACT_NAME
pnpm --filter @bam/api db:backfill-pii --finalize --maintenance --database EXACT_NAME
pnpm --filter @bam/api db:backfill-pii --verify
```

Default is dry-run. Conversion is paginated with per-row transactions and checks
for concurrent writes. Re-running authenticates existing ciphertext, rather than
double-encrypting it. Finalization validates _all_ targeted rows and indexes before
clearing old plaintext lookups. Keep old columns null until a subsequent cleanup
migration. Do not reopen on a failed validation or changed row count.

Encryption covers the agreed Customer fields and Booking snapshots. It does not
claim to encrypt conversation transcripts, notification recipients, idempotency
payloads, free-text notes, or all personal information in the database. Restrict
database access, encrypt backups, and enforce retention for those other records.

## Test-to-live billing transition

Preserve all accounts/bookings. For each existing customer tenant, use the **old
test account key** to verify its external references. Never infer mode from an ID.

```sh
pnpm --filter @bam/api billing:transition-test --tenant TENANT_ID
pnpm --filter @bam/api billing:transition-test --tenant TENANT_ID --apply --maintenance --database EXACT_NAME
```

If Billingo mappings exist, inspect their old environment and add
`--confirm-test-billingo` only for confirmed test documents. Unknown/deleted Stripe
references and unclassified pending events block the command for investigation.
Internal or closed organizations are excluded. The command encrypts an immutable
archive, detaches test mappings, preserves trial-use history, and sets paid access
back to pending. It quarantines that tenant's pending billing events and
notifications; Redis jobs targeting skipped notifications cannot send. Booking
notifications and other tenants are untouched. The command performs no external
Stripe/Billingo mutations or charges. Old sandbox payment links are still sandbox
links; disable their use in the old environment as an operator cleanup task.

Switch API and worker together to the confirmed live configuration. Validate the
9,990/24,990 HUF monthly prices and existing AAM treatment with the owner; check the
live webhook delivery/signing configuration and Billingo settings separately.
Use the existing `stripe:catalog --verify` command with the intended live account.
Mode-mismatched inbound events are acknowledged without entitlement changes;
the worker also refuses mismatched/unclassified stored events.

Existing customer organizations must complete new live checkout. Test billing
events are not promoted to live entitlements. Exercise failure/retry/cancellation
in the sandbox and observe the first genuine customer purchase; do not create
artificial live charges as a smoke test.

## Validation, promotion and rollback

Run formatting, lint, types, tests, build, browser tests, production dependency
audit, migration drift and migrations-from-scratch checks. API/DB/worker integration
suites share tables: run through Turbo or serially, never API and worker concurrently.
Use isolated test databases, not production. Build/start Linux images and verify
the selected revision through the actual Coolify proxy.

Smoke-check health/readiness, owner verification, allowlist refusal, staff roles,
cross-tenant denial, multilingual chat, embedded booking, QR/PWA, booking/cancel,
reminders, and fresh live checkout during real onboarding. Worker health now tests
heartbeat freshness; monitor actual progress separately: oldest due outbox/notification
over five minutes, failed jobs, unprocessed Stripe events, and invoice failures.
Route alerts to the owner without customer payloads. External HTTP probes should
alert after two consecutive one-minute failures.

Before conversion, retain previous images and a fresh maintenance backup. Before
reopening, failure permits restoring that backup and the previous code while writes
remain stopped. **Never deploy pre-encryption code onto encrypted data.** After
reopening, roll back only to an encryption-compatible revision; restoring an older
database requires stopping writes and reconciling subsequent bookings/payments.
Database restore does not undo Stripe or Billingo actions.

Keep invite-only mode for the first five businesses for seven days. Record actual
purchase/access/invoice and booking/notification outcomes, inspect alerts daily,
and resolve critical defects before increasing the cohort. Public signup requires
a separate expansion decision.

For a data deletion request, verify identity and tenant authority, identify all
customer records and booking/transcript/notification copies, check required billing
retention with the owner, execute a reviewed tenant-scoped deletion/anonymization,
and record completion without raw PII. Backups expire under retention and any restore
must reapply recorded deletions. On an incident: restrict affected access, preserve
redacted evidence, stop damaging writes, assess affected tenants and involve the owner
for required notifications before resuming service.
