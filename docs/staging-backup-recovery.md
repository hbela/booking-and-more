# Staging backup and recovery

Status: 2026-09-21. Chosen path: VPS systemd timer → PostgreSQL custom-format
dump → encrypted Restic repository → Cloudflare R2.

Monitoring choice: UptimeRobot for backup heartbeats and availability, Sentry for
application errors. Follow [monitoring setup](monitoring-setup.md) to connect them.

## Prepared infrastructure

- Bucket: `booking-for-all-bucket`.
- Separate staging repository prefix: `booking-and-more/staging`.
- Staging Compose project: `zcskco80804ogk4gskwoso40`.
- Environment-specific service: `bam-backup@staging.service`.
- Environment-specific timer: `bam-backup@staging.timer` (currently **disabled**).
- Non-secret configuration: `/etc/bam/staging-backup.conf`.
- Root-only credential files: `/etc/bam/staging-restic.password`,
  `/etc/bam/staging-r2-access-key`, `/etc/bam/staging-r2-secret-key`.
- Required monitor credential, not yet supplied:
  `/etc/bam/staging-backup-monitor-url`.

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

## Finish configuration and enable scheduling

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
