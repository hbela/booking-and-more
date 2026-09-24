# Staging backup and recovery

Status: 2026-09-21. Chosen path: VPS systemd timer → PostgreSQL custom-format
dump → encrypted Restic repository → Cloudflare R2.

Update 2026-09-24: SSH inspection confirms the staging timer is enabled and active.
Cloudflare and Resend monitoring is deployed, email rehearsals passed, and a real
manual backup reported success. Both the 15:00 and 15:30 Budapest scheduled runs on
2026-09-24 succeeded in systemd and D1. The operator deleted the Sentry backup Cron
monitor, and the VPS legacy URL credential was emptied after preserving its rollback
copy. The staging monitoring cutover is complete. See [custom backup monitoring](backup-monitor.md)
for evidence and rollback. Sentry remains in use for application errors.

## Prepared infrastructure

- Bucket: `booking-for-all-bucket`.
- Separate staging repository prefix: `booking-and-more/staging`.
- Staging Compose project: `zcskco80804ogk4gskwoso40`.
- Environment-specific service: `bam-backup@staging.service`.
- Environment-specific timer: `bam-backup@staging.timer` (**enabled and active**, verified 2026-09-24).
- Non-secret configuration: `/etc/bam/staging-backup.conf`.
- Root-only credential files: `/etc/bam/staging-restic.password`,
  `/etc/bam/staging-r2-access-key`, `/etc/bam/staging-r2-secret-key`.
- Legacy monitor credential: `/etc/bam/staging-backup-monitor-url` remains present
  but empty after cutover; its protected rollback copy is recorded in the monitor runbook.

The service loads credentials using systemd `LoadCredential`; the Python launcher
passes them to Restic and the monitor in memory. Credentials are not committed to
Git or printed in logs. Restic credentials were copied from the existing Coolify
R2 configuration; these are not newly scoped storage credentials. Consider a
separate bucket and credential scope for production.

Use the new `@staging` units. The older `bam-backup.timer` remains disabled and is
not a second scheduler. A Coolify scheduled task whose command is
`bam-backup.timer` inside the PostgreSQL container is invalid and should be disabled.

## Completed manual rehearsal

- Initialized the encrypted R2 repository and streamed a successful database dump.
- Recoverable snapshot:
  `305666656cf281a1acc6046db1c432a0514426a0bf0573537c7550dc7138cd08`.
- Snapshot timestamp: `2026-09-21T11:55:39.241002258Z`.
- Restored into a newly created PostgreSQL 18 container with no network access,
  no published ports, and temporary storage; removed it after validation.
- Restored counts: one user, zero tenants/customers/bookings/subscriptions,
  and 42 migration records.
- Container provisioning, database restore and validation took approximately
  seven seconds. No staging records were changed.
- Five isolated backup-script tests passed; shell syntax and systemd unit checks passed.
- Restic `check --read-data` passed and the agreed retention policy was applied.

This is a database restore proof, not a complete four-hour service recovery drill.
There were no customer fields to decrypt. Repeat with representative staging
bookings and recover keys from their independent backup before declaring the
encryption recovery and full service recovery gates passed.

## Application recovery drill — 2026-09-24

The [staging application recovery drill](staging-recovery-drill-2026-09-24.md)
restored the 14:30 UTC R2 snapshot into isolated PostgreSQL/Redis volumes and
started the deployed API, web and worker images. Baseline counts matched. Synthetic
encrypted customer/booking dump-and-restore checks, booking reads, password
sign-in/session checks, invalid-key rejection and Redis queue reconstruction passed.
No external notifications were sent; all temporary resources were removed.

The initial run took 78.97 seconds (80.23 including cleanup). A second run used
Restic/R2 credentials, the authentication secret and both PII keys retrieved from
the independent KeePassXC vault, and passed in 79.21 seconds (80.50 with cleanup).
All three application keys matched staging; R2 decryption used no VPS credential files.
**Full recovery acceptance remains open:** both runs used cached images on the
existing VPS. Complete configuration, independent image recovery, clean-host
provisioning and the intended HTTPS/browser path still need verification.
The original snapshot had no customer or booking rows; synthetic data was added
only in the isolated copy. Staging data and its running services were unchanged.

## Original activation checklist and ongoing recovery checks

Scheduling is already active as of 2026-09-24; do not repeat initialization or reset
the repository. For monitoring changes use the [cutover runbook](backup-monitor.md).
The historical checklist below also records outstanding recovery responsibilities.

1. Create an external monitor that alerts after 50 minutes without a successful
   backup. Store its heartbeat URL in the root-readable monitor credential file.
2. Securely copy the Restic repository password, R2 access credentials, both
   staging PII keys, authentication settings and recovery instructions into the
   operator's independent password manager/recovery storage. The VPS-only copies
   do not protect against loss of the VPS.
3. Run the installed service manually and inspect its result:

   ```sh
   sudo systemctl start bam-backup@staging.service
   sudo journalctl -u bam-backup@staging.service -n 50 --no-pager
   ```

4. Confirm the recoverable snapshot and monitor success, then enable the timer:

   ```sh
   sudo systemctl enable --now bam-backup@staging.timer
   sudo systemctl list-timers bam-backup@staging.timer
   ```

5. Observe two successful runs 30 minutes apart and exercise the missing-success
   alert. The script retains every snapshot for seven days and daily copies for
   30 days. Only `bam-staging` snapshots count as successful backup candidates;
   failed `bam-staging-pending-*` attempts must not satisfy the backup-age check.
6. Repeat an isolated restore monthly, including application checks and PII
   decryption with recovered keys. Rebuild queues with outgoing integrations
   disabled during the rehearsal; a database dump alone does not back up Redis.

Production will need its own repository, Compose project identifier, credentials,
`BACKUP_TAG=bam-production`, service/timer instance, monitor and recovery evidence.
