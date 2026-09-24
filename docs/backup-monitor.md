# Custom backup monitor

Implementation: Cloudflare Worker + D1 + Resend, independent of the Hetzner VPS.
The backup still runs every half hour through `bam-backup@staging.timer`.
Sentry continues to collect application errors. No UptimeRobot subscription is needed.

## Current evidence (2026-09-24)

- The staging timer remains **enabled and active**, on its original half-hour schedule.
- Cloudflare authentication is verified. The staging and rehearsal D1 databases
  are created in EEUR, their IDs are recorded in the Wrangler configurations, and
  migration `0001_monitor.sql` has been applied to both remote databases.
- Staging Worker deployed at `https://bam-backup-monitor.hajzerbela.workers.dev`,
  version `1474c4c0-158c-4a91-971e-520b33470a4e`, with five-minute cron.
  It was explicitly armed at `2026-09-24T12:43:38Z`.
- Both Workers use the dedicated `RESEND_API_KEY-FOR-BACKUP` from the operator's
  local `.env`, uploaded as the Worker secret `RESEND_API_KEY` through stdin.
  The file was not modified. Sender: `support@tanarock.hu`; recipient:
  `hajzerbela@gmail.com`. Independent random monitor tokens were configured.
- Rehearsal failure, scheduled silence, overrun and their three recoveries passed.
  All six emails were accepted by Resend and found in the recipient's Gmail inbox.
  Silence was detected by a real cron invocation at `2026-09-24T12:40:43Z`.
  No pending or blocked rehearsal notifications remained after testing.
- Rehearsal cron was disabled and redeployed (version
  `f64a5003-f3b5-4078-a98f-bf4ecc093dc1`). Its D1 evidence is retained.
- Installed all three backup scripts and the staging systemd monitor drop-in.
  The token is root-owned, mode 0600. Pre-change scripts and the unchanged legacy
  URL credential are preserved under `/var/backups/bam-monitor/20260924T124347Z`;
  `scripts.sha256` records the original script checksums.
- First manual backup succeeded but check-ins hit Cloudflare HTTP 403/error 1010.
  Adding `User-Agent: BAM-Backup-Monitor/1.0` to the helper resolved the rejection;
  the HTTP test now asserts this header. A second genuine manual backup ran
  `2026-09-24T12:46:15Z`–`12:46:30Z` and succeeded in systemd and D1, with run ID
  `8d6916df-6dc7-496c-92f9-4946989fdc0d`. Its `last_success` equals its start time.
- First scheduled acceptance run verified on 2026-09-24: started at
  `13:00:03Z` and finished at `13:00:19Z` (15:00:03–15:00:19 Budapest time).
  Systemd reported `Result=success`, `ExecMainStatus=0`; its timer confirmed the
  scheduled trigger. D1 recorded run `cb8ba1f9-2ad3-4d2f-8321-bcf8712c99bf` as
  `succeeded`, with `last_success=2026-09-24T13:00:03Z` and no active incident.
  The VPS journal reported snapshot `3e8eba68` saved before tag promotion.
  No staging notifications were queued: routine successful backups do not send
  email; recovery emails are sent only when an incident closes.
- Second scheduled acceptance run verified on 2026-09-24: started at
  `13:30:02Z` and finished at `13:30:17Z` (15:30:02–15:30:17 Budapest time).
  Systemd reported `Result=success`, `ExecMainStatus=0`; its timer confirmed the
  scheduled trigger. D1 recorded run `9ece5fcb-a60a-4de6-9fe6-e8dfbd2068a2` as
  `succeeded`, with `last_success=2026-09-24T13:30:02Z` and no active incident.
  The VPS journal reported snapshot `c4032c8b` saved before tag promotion.
- **Staging monitoring cutover complete:** the operator confirmed deletion of the
  Sentry backup Cron monitor. At `2026-09-24T13:51:38Z`, while the backup service
  was idle, the legacy URL credential was verified against its protected rollback
  copy and emptied. `/etc/bam/staging-backup-monitor-url` remains present,
  root-owned, mode 0600, zero bytes, so subsequent runs skip legacy pings.
  The timer remains enabled and active. Cloudflare/Resend is now authoritative
  for staging backup monitoring; Sentry application monitoring is unchanged.
- Provider quota headroom has not been independently reviewed. Full application
  recovery and separate encryption-key recovery remain separate launch gates.
- Local verification passed: 17 monitor tests against Miniflare D1, 10 isolated
  Linux backup-script tests and three HTTP-helper tests. Type-check, lint,
  formatting, shell syntax and the Wrangler deployment dry-run also passed.

## Behavior and interface

`POST /v1/check-ins/bam-staging`, with `Authorization: Bearer <dedicated token>`:

```json
{ "runId": "86df2f92-537d-450f-b652-de703c589373", "status": "started", "startedAt": 1790200000 }
```

Use the same UUID and Unix start timestamp for the terminal `succeeded` or `failed`
event. Only failures include `stage`: `configuration`, `lock`, `database`,
`dump_upload`, `promotion`, or `retention`. No free-text errors are accepted.
The monitor validates a maximum 1 KiB body, start timestamps within the last hour
and at most 60 seconds ahead, and rejects unknown fields. Unknown monitors get
404; invalid authentication gets 401; invalid events get 400; success gets 204.
Duplicates are acknowledged without refreshing freshness; the first terminal event
wins. A conflicting start timestamp cannot modify an existing run.

D1 batches atomically update runs, incidents and the notification outbox. The
five-minute cron checks for a 20-minute overrun or 50-minute backup age. Age uses
the successful backup's **start**, not receipt time. Failed check-ins enqueue alerts
immediately. Initial, six-hour reminder and recovery emails are deduplicated.
Only a fresh successful backup clears an incident. No first success is also an alert.

Resend failures leave durable pending emails, leased during dispatch and retried
at subsequent checks. Keys and email bodies stay stable. Because Resend retains
idempotency keys for only 24 hours, ambiguous deliveries stop automatic retries
after 23 hours and log a redacted reconciliation warning. Inspect these in D1 and
Resend before retrying manually; do not blindly clear `first_attempt` or `blocked`.
Closed incident and run history is retained for 30 days; open incidents survive.

## Deploy and rehearse

Run commands from the repository root. No credential values belong in Git,
Wrangler configuration, a command-line argument, or a deployment transcript.

1. Authenticate: `corepack pnpm --filter @bam/backup-monitor exec wrangler login`.
   Check `wrangler whoami`, choose the existing Cloudflare account, and confirm its
   Workers/D1 free quota headroom and Resend sending quota in their dashboards.
   No paid upgrade is required by this implementation. Shared-account usage still
   counts. The cron executes 288 times/day; staging normally sends 96 check-ins/day.
2. For a new installation, create two D1 databases with `wrangler d1 create bam-backup-monitor` and
   `wrangler d1 create bam-backup-monitor-rehearsal` (use the same pnpm prefix).
   Put their non-secret IDs in the matching Wrangler files in `apps/backup-monitor`.
   These databases and migrations already exist for this installation; reuse them.
3. For each configuration, use `wrangler secret put NAME --config FILE` to configure:

   | Secret           | Value                                                                                                      |
   | ---------------- | ---------------------------------------------------------------------------------------------------------- |
   | `MONITOR_TOKENS` | JSON object mapping `bam-staging` (or `bam-test`) to an independent random token of at least 32 characters |
   | `RESEND_API_KEY` | Dedicated sending-only key scoped to the verified monitoring sender domain                                 |
   | `ALERT_FROM`     | Verified bare email address, without a display name                                                        |
   | `ALERT_TO`       | Explicit operator email address                                                                            |

   Files are `wrangler.jsonc` and `wrangler.rehearsal.jsonc`, relative to the workspace.
   Keep a separate token for rehearsal. Use interactive secret prompts or protected
   stdin; do not create a tracked or plaintext environment file.

4. Apply migrations with `wrangler d1 migrations apply DB --remote --config FILE`.
   Re-enable `*/5 * * * *` in the rehearsal configuration for a new drill; its
   checked-in cron list is empty after the accepted 2026-09-24 rehearsal.
   Deploy **rehearsal first** using `wrangler deploy --config wrangler.rehearsal.jsonc`.
   The initial scheduled invocation arms it; no app database is involved.
5. Send authenticated synthetic start/failure events to `bam-test`, confirm failure
   email receipt, then send a new successful run and confirm recovery. Test silence
   using D1 to set the rehearsal monitor's `armed_at=unixepoch()-3000` with no success,
   and test overrun with a synthetic start aged 20 minutes. Do not manipulate staging
   state for tests. Record timestamps, event IDs and operator receipt.
6. Deploy the staging Worker. Immediately arm it explicitly, without resetting an
   existing monitor, so the deadline is not delayed until the first cron invocation:

   ```sh
   corepack pnpm --filter @bam/backup-monitor exec wrangler d1 execute DB --remote --command "INSERT OR IGNORE INTO monitors(id,armed_at) VALUES ('bam-staging',unixepoch())"
   ```

7. Remove the rehearsal Worker's cron trigger after acceptance, redeploy that
   configuration, and retain rehearsal resources only if wanted for future drills.
   Leaving an armed silent rehearsal running will send repeated incident emails.

## Switch the VPS without interrupting backups

1. Inspect `systemctl is-active bam-backup@staging.service` and stage files separately.
   Wait for any active backup to finish before atomically replacing scripts; leave
   the timer enabled. Securely preserve the existing scripts and URL credential as
   the rollback reference, with a timestamp and checksum.
2. Install `backup.sh`, `backup-service.py`, and `backup-check-in.py` together under
   `/opt/bam/ops/production`. Store the staging token, matching the Cloudflare secret,
   in `/etc/bam/staging-backup-monitor-token`, root-owned mode 0600.
3. Install the drop-in based on `ops/production/backup-monitor.conf.example`, replacing
   its endpoint with the deployed staging workers.dev URL. Run `systemctl daemon-reload`.
   Keep the existing Sentry URL credential loaded during acceptance. No backup data,
   retention settings, database configuration or timer schedule changes are needed.
4. Observe **two actual scheduled runs**, approximately 30 minutes apart, in the
   systemd journal and D1. Verify terminal success and start-based backup age:

   ```sh
   corepack pnpm --filter @bam/backup-monitor exec wrangler d1 execute DB --remote --command "SELECT id,armed_at,last_success,reason FROM monitors; SELECT monitor,started_at,status,stage FROM runs ORDER BY started_at DESC LIMIT 10; SELECT id,sent_at,blocked FROM notifications ORDER BY created_at DESC LIMIT 10"
   ```

5. Only after email acceptance and those runs, disable the Sentry backup Cron monitor
   and empty the VPS's legacy URL credential file, preserving its protected rollback
   copy. Keep the credential file present: the existing unit references it. The next
   run loads the empty value and skips legacy pings. Do not disable Sentry app projects.
6. Rollback: restore the protected scripts/URL credential, remove the new systemd
   drop-in, reload units and re-enable the Sentry Cron monitor if needed. Preserve
   all backup snapshots and keep the same timer. Record which monitor is authoritative.

## Limits and operation

Monitoring delivery failure never blocks the backup pipeline or changes its exit
code. Each check-in makes at most two attempts with five-second HTTP timeouts,
inside a 15-second process deadline that also bounds DNS lookup delays.
Hard process termination may prevent a failure check-in; overrun/staleness covers it.
The launcher cannot report a failure before it starts; missing success still alerts.

Cloudflare hosts both R2 and this monitor, so a provider-wide outage can affect both.
The monitor cannot independently notify when its own cron or email provider is down;
inspect scheduled invocations, pending/blocked emails and quota periodically. The
five-minute schedule aims for detection between 50 and 55 minutes, not a guaranteed
email-delivery SLA. Restore rehearsals, encryption key backups and disk monitoring
remain separate responsibilities. This service does not prove a dump is restorable.

To add production later, register `bam-production` explicitly in `MONITOR_IDS`, add
an independent token, seed its `armed_at` at activation and wire its own service.
Rehearsal state must never share staging's monitor ID or token.

References: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[Resend idempotency](https://resend.com/changelog/idempotency-keys),
[Cloudflare error 1010](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/).
