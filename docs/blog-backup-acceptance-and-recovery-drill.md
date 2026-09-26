# From scheduled backups to a working application: our staging recovery drill

_Booking and More · September 24–25, 2026_

We wanted evidence that our backups ran on schedule, that failures reached us,
and that we could recover the application after losing its server. A successful
database restore was already on record, but it left several questions unanswered:
could we recover encryption keys independently, rebuild application images, restore
background jobs, and sign in through a real HTTPS browser session?

This post walks through the two pieces of work: accepting the scheduled backup
system, then recovering staging on a clean server. Both staging exercises passed.
The final browser check finished about **2 hours 10 minutes after software
provisioning began**, including a wait for DNS changes. Manual server creation and
SSH troubleshooting happened before that timer, so we do not present this as a
fully measured production recovery within four hours.

## The system we tested

| Component                     | Responsibility                                                        |
| ----------------------------- | --------------------------------------------------------------------- |
| Hetzner VPS and systemd timer | Start a PostgreSQL backup every 30 minutes                            |
| PostgreSQL `pg_dump`          | Produce a custom-format database dump                                 |
| Restic and Cloudflare R2      | Encrypt and store backups outside the VPS                             |
| Cloudflare Worker and D1      | Track backup runs, detect missing successes and retain incident state |
| Resend                        | Deliver failure and recovery emails                                   |
| KeePassXC                     | Keep recovery credentials independent of the application server       |
| Temporary Hetzner VPS         | Prove recovery without using the original server's images or secrets  |
| Caddy and Chromium            | Exercise valid HTTPS and actual browser authentication                |

The monitor runs outside the VPS, so a stopped server cannot silence it simply by
stopping the backup process. R2 and the monitor do share Cloudflare, however; this
does not provide independence from a Cloudflare-wide outage.

The commands below illustrate the checks we used. Run pnpm commands from the
repository root, and Linux commands on the named VPS. Recovery values belong in
protected prompts or process input, never in this document or command history.

## Part 1: finish backup acceptance

### Step 1 — Confirm the backup pipeline and schedule

The staging service was `bam-backup@staging.service`, triggered by
`bam-backup@staging.timer`. We checked that the timer was enabled and active:

```bash
systemctl is-enabled bam-backup@staging.timer
systemctl is-active bam-backup@staging.timer
systemctl list-timers bam-backup@staging.timer
```

Each execution locates the current PostgreSQL container using its Compose labels.
That avoids retaining a container name which a later deployment might replace.
It streams `pg_dump -Fc` into Restic without leaving a plaintext dump on disk.

The script initially gives the snapshot an attempt-specific pending tag. Only
after the complete dump/upload pipeline succeeds does it promote the snapshot to
`bam-staging`. Retention then runs before the monitor receives success.

This distinction matters: a failed dump producer can still leave a snapshot in
Restic. A snapshot's existence alone does not make it an accepted backup.

### Step 2 — Set up independent backup monitoring

We used a Cloudflare Worker with D1 for persistent state and Resend for delivery.
The staging monitor was `bam-staging`; synthetic alert tests used a separate
`bam-test` monitor and separate credentials.

Cloudflare CLI authentication used:

```powershell
corepack pnpm --filter @bam/backup-monitor exec wrangler login
```

We configured a dedicated Resend key, a verified sender domain, sender and recipient
addresses, and independent authentication tokens for backup check-ins. The Worker
expects its key under `RESEND_API_KEY`, regardless of the operator's local name
for that dedicated key.

Each backup sends a `started` event and a terminal `succeeded` or `failed` event
with the same run ID and start timestamp. D1 stores runs, incidents and pending
notifications. A five-minute Worker cron checks for overdue backups.

| Condition                              | Monitor behavior                           |
| -------------------------------------- | ------------------------------------------ |
| Explicit backup failure                | Queue a failure notification               |
| Run exceeds 20 minutes                 | Open an overrun incident                   |
| No successful backup within 50 minutes | Open a stale-backup incident               |
| Fresh success after an incident        | Close the incident and send recovery email |
| Ordinary successful backup             | Record success without sending email       |

Freshness is based on when the successful backup **started**, rather than when its
check-in arrived. Delivery failures stay in a durable outbox for controlled retry.

### Step 3 — Rehearse failure and recovery emails

We tested explicit failure, missing scheduled success and overrun in the rehearsal
monitor. Each was followed by a fresh successful run to exercise recovery.

All **six emails**—three alerts and three recoveries—were accepted by Resend and
found in the recipient's inbox. We then disabled the rehearsal cron to prevent
an intentionally idle test monitor from sending further alerts.

One integration problem appeared during real backup check-ins: Cloudflare rejected
the Python helper with HTTP 403/error 1010. Adding the explicit header
`User-Agent: BAM-Backup-Monitor/1.0` resolved the rejection in our deployment, and
we added an HTTP regression assertion for it.

### Step 4 — Observe two actual scheduled backups

A manual success was useful, but acceptance required the timer itself to run twice.
We observed the September 24 backups scheduled for **15:00 and 15:30 Budapest time**.
Budapest was UTC+2 on those dates.

| Scheduled time, Budapest | Actual UTC interval | Result                   |
| ------------------------ | ------------------- | ------------------------ |
| 15:00                    | 13:00:03–13:00:19   | Systemd and D1 succeeded |
| 15:30                    | 13:30:02–13:30:17   | Systemd and D1 succeeded |

On the VPS, we inspected the historical journal and the service's latest result:

```bash
journalctl -u bam-backup@staging.service --utc \
  --since '2026-09-24 12:55:00 UTC' \
  --until '2026-09-24 13:35:00 UTC' --no-pager

systemctl show bam-backup@staging.service -p Result -p ExecMainStatus
```

`systemctl show` describes the latest execution; use the journal for older runs.
The recorded executions reported `Result=success` and `ExecMainStatus=0`.

We also inspected D1 from the repository root:

```powershell
corepack pnpm --filter @bam/backup-monitor exec wrangler d1 execute bam-backup-monitor --remote --command "SELECT id, datetime(last_success,'unixepoch') AS last_success_utc, reason FROM monitors; SELECT id, monitor, datetime(started_at,'unixepoch') AS started_utc, status, stage FROM runs ORDER BY started_at DESC LIMIT 10;"
```

The matching run IDs were:

- 15:00: `cb8ba1f9-2ad3-4d2f-8321-bcf8712c99bf`
- 15:30: `9ece5fcb-a60a-4de6-9fe6-e8dfbd2068a2`

Both had terminal success and no active incident. The absence of a 15:00 email
was expected: ordinary successes are recorded, not emailed.

For dashboard inspection, use Cloudflare's D1 console for run/incident records and
the Worker's logs or scheduled-invocation view for monitor execution. The VPS
journal remains the evidence for the actual database backup process.

### Step 5 — Correlate backup runs with recoverable snapshots

With repository credentials supplied securely, inspect accepted snapshots:

```bash
restic snapshots --tag bam-staging --json
```

Match snapshot timestamps and environment tags against the journal and D1 run
times. Exclude pending-attempt snapshots from acceptance.

The scheduled-run journals recorded short snapshot IDs `3e8eba68` and `c4032c8b`
**before tag promotion**. Restic tag changes can change the snapshot ID, so do not
assume those short IDs are the final IDs returned by a later snapshot listing.
Our monitoring evidence retains the pre-promotion IDs; a repeatable acceptance
record should also capture the final tagged IDs at inspection time.

For the application recovery tests, we pinned a separately recorded, recoverable
14:30 UTC snapshot:

```text
5185871c39c19764b5d50dc09d4d10af138098c4d05b3003fd11d0dbbca62bef
```

Restoring it supplied the stronger evidence: its encrypted contents could actually
be read and loaded into PostgreSQL.

### Step 6 — Retire the legacy Sentry backup monitor

After the email rehearsals and two scheduled successes, the operator deleted the
Sentry backup Cron monitor. We preserved a protected rollback copy of the previous
scripts and legacy URL credential before disabling its VPS heartbeat.

We emptied `/etc/bam/staging-backup-monitor-url` while the backup service was idle,
but kept the file present with its original restricted permissions. The systemd
unit still referenced it, and an empty value let subsequent runs skip legacy pings.

The backup timer stayed active throughout. Cloudflare/Resend became authoritative
for backup monitoring; **Sentry application-error monitoring remained in place**.

## Part 2: recover the application on a clean host

### Step 7 — Start with an isolated application restore

Before provisioning another VPS, we exercised the restore in temporary containers
on the existing server. Each drill owned its own PostgreSQL and Redis volumes and
an internal Docker network, with no published ports or public routing.

Email, payment, invoicing, calendar and other integration credentials were absent
or cleared. An outbound TCP check confirmed the application could not reach an
external endpoint. No notification was marked sent.

The first successful application drill took **78.97 seconds**, but it reused the
surviving server's secrets and cached images. It proved application restoration,
not independence from that server.

### Step 8 — Recover the existing secrets from KeePassXC

We prepared a `Booking-and-more-Staging` group in an independent KeePassXC vault.
It contained the Restic repository password, R2 access key and secret, repository
address/configuration, and these three application entries:

```text
BETTER_AUTH_SECRET
CUSTOMER_PII_ENCRYPTION_KEY
CUSTOMER_PII_BLIND_INDEX_KEY
```

The entries held the **existing staging values**. Generating replacement keys
would not recover data encrypted under the original keys.

A local masked prompt unlocked the vault for the scoped reads. Secrets travelled
in memory and through encrypted SSH stdin. The temporary local recovery-value copy
used Windows DPAPI protection and was removed after use; secrets were not committed
or printed in the reports.

We verified that all three application values matched staging, then opened and
decrypted the R2 backup with vault-sourced credentials. The repository address was
stored in the configuration entry's Notes field, rather than its URL field.

The vault-sourced isolated rerun passed in **79.21 seconds**. Independent secret
recovery was now demonstrated; independent images and a clean host were next.

### Step 9 — Provision a temporary recovery server

We created `bam-recovery-drill` in a separate Hetzner project:

| Setting                                 | Choice                                                                |
| --------------------------------------- | --------------------------------------------------------------------- |
| Server                                  | CAX21, ARM64, 4 CPUs, 8 GB RAM, 80 GB disk                            |
| Operating system                        | Ubuntu 24.04                                                          |
| Networking                              | Public IPv4                                                           |
| SSH key                                 | Existing operator public key, named `Bela-Windows`                    |
| Intended inbound rules                  | SSH from the operator; HTTP/HTTPS for certificate issuance and access |
| Extra volumes and scheduled VPS backups | None                                                                  |

An early attempt omitted selecting the SSH key during server creation. Adding a
key to the project had not installed it on that server. Because the server was
unused, we recreated it with **Bela-Windows explicitly selected**.

We also encountered a public-key paste error. The local Ed25519 key was valid;
copying its canonical key-type and base64 fields without the optional comment
resolved the console rejection. No private key was uploaded.

On Windows, inspect which identity an SSH alias uses with:

```powershell
ssh -G hetzner | Select-String '^identityfile '
```

The public-key file ends in `.pub`; the corresponding file without that suffix is
private. The email at the end of a public-key line is only an identifying comment.

SSH then succeeded on the replacement server. We confirmed its hostname, ARM64
architecture, Ubuntu version, free disk space and completed cloud initialization
before installing Docker Engine and Restic.

### Step 10 — Rebuild images from an independent source

We exported the recorded staging revision from the operator's local Git checkout:

```powershell
git archive --format=tar --output=docs/tmp/recovery-source.tar c2d7b5190f5703a6346dc0680fb67928df243cc1
Get-FileHash docs/tmp/recovery-source.tar -Algorithm SHA256
```

This archive contained committed source, rather than the working directory's
secrets or installed dependencies. We verified its checksum after transfer.

On the clean server we rebuilt API and worker from their shared Dockerfile stages,
then built the web image with its recovery API origin:

```bash
docker build --pull --target api-runtime -f docker/Dockerfile.api \
  -t bam-recovery-api:c2d7b51 .

docker build --target worker-runtime -f docker/Dockerfile.api \
  -t bam-recovery-worker:c2d7b51 .

docker build --pull -f docker/Dockerfile.web \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://recovery-api.booking.appointer.hu \
  -t bam-recovery-web:c2d7b51 .
```

The web build argument was essential: Next.js embeds this public API address into
the browser bundle. Changing only a container's runtime environment would leave
the browser calling the old API.

PostgreSQL and Redis were pulled from the registry by recorded digests. No cached
images, database volumes or runtime secrets were copied from staging. Builds and
registry pulls completed between **12:51:28 and 12:54:59 UTC**.

### Step 11 — Restore the database and validate application data

The recovery runner streamed the selected R2 snapshot through Restic into
`pg_restore`, using an empty PostgreSQL instance and an independent empty Redis.
Its initial baseline was one user, zero tenants/customers/bookings and 42 completed
migration records.

Because that backup contained no customer or booking rows, we created synthetic
records **only inside the recovered stack**, then performed a second local
dump/restore. The checks covered:

- Decrypting customer fields and booking snapshots.
- Matching the restored email blind index for the correct tenant.
- Producing a different blind index for another tenant.
- Rejecting an incorrect encryption key and missing PII keys.
- Reading the restored booking through the application API.
- Signing up, signing in and retrieving an authenticated session.

These checks establish that encrypted application records survive serialization
and can be read with the recovered keys. They do not establish recovery of
historical customer ciphertext from R2: the synthetic data was added after the
off-host restore.

The inaccessible drill used public launch mode so email delivery could remain
disabled. This was a deliberate recovery-test override, not a test of the
production invite-only onboarding policy.

### Step 12 — Prove recovery after Redis loss

We added a delayed synthetic notification to the recovered PostgreSQL database.
Starting the worker reconstructed its queue job in empty Redis.

Next we stopped that worker, cleared **only the drill-owned Redis**, restarted the
worker and checked that the delayed job was reconstructed again. No real customer
notification was sent. We stopped the worker during the later DNS wait.

The clean-host restore and application checks finished in **96.70 seconds**.

### Step 13 — Add recovery DNS without breaking staging

The existing `*.appointer.hu` wildcard pointed to staging. The recovery host needed
its own names and address. We added these A records, with TTL 60:

| Record                              | Destination            |
| ----------------------------------- | ---------------------- |
| `*.booking.appointer.hu`            | Existing staging VPS   |
| `recovery-app.booking.appointer.hu` | Temporary recovery VPS |
| `recovery-api.booking.appointer.hu` | Temporary recovery VPS |

The additional `*.booking` wildcard preserved staging resolution when explicit
records created a deeper branch in the DNS tree. We kept the original wildcard
unchanged and verified all four application names after the update: the recovery
pair reached the new server, while staging's web and API still reached the old one.

The prepared HTTPS script refused to start before recovery DNS pointed to the
correct IP. Caddy then obtained certificates and proxied the two recovery origins.
Application access was restricted to the operator and recovery-host IPs. Only the
proxy joined both the public and internal Docker networks.

### Step 14 — Exercise the recovered application in Chromium

The browser test used real HTTPS without bypassing certificate validation. All
ten checks passed:

1. Web HTTPS and sign-in rendering.
2. API HTTPS readiness.
3. UI signup sent to the rebuilt recovery API origin.
4. Password sign-in through the UI.
5. Secure, HttpOnly session cookies.
6. Cross-origin session retrieval using browser cookies.
7. Authenticated application API access.
8. Reading the restored encrypted booking from the browser.
9. Session persistence after a page reload.
10. No browser requests to staging or external integrations.

The browser run completed at **14:59:12.849 UTC on September 25**. Web TLS used
TLS 1.3. The test account and booking were synthetic; existing account passwords
were not changed.

### Step 15 — Preserve evidence and clean up

We saved credential-free reports containing the source revision, image IDs,
snapshot ID, timestamps and check results. Reports were copied off the temporary
server before teardown.

Cleanup selected resources by the drill's exact ownership label. We removed its
containers, database/Redis/TLS volumes and networks, then verified that none
remained. Cleanup completed at **15:00:08 UTC**. Staging web health and API readiness
both returned HTTP 200 afterward.

At the last recorded check, deleting the temporary VPS and its two explicit
recovery DNS records remained operator teardown steps. They are not recorded as
completed here. Keep the wildcard records used by staging. A stopped or idle VPS
must not be mistaken for a deleted, no-longer-billed resource.

## What the results establish

| Objective                                     | Recorded outcome                               |
| --------------------------------------------- | ---------------------------------------------- |
| Two genuine scheduled successes               | Passed in the VPS journal and D1               |
| Failure/recovery email delivery               | Six rehearsal emails received                  |
| Legacy backup-monitor retirement              | Completed; application Sentry retained         |
| Independently stored credentials and PII keys | Retrieved from KeePassXC and used successfully |
| Independent image recovery                    | Rebuilt recorded source on a clean ARM64 VPS   |
| Application and queue restoration             | Passed with isolated data and integrations     |
| HTTPS/browser recovery                        | All ten checks passed                          |
| Temporary stack cleanup                       | Completed and verified                         |

The measured interval from software provisioning to browser success was
**2 hours 10 minutes 0.849 seconds**, including DNS waiting. That is useful evidence
against the four-hour target, with a clearly defined starting point.

The remaining limits are equally concrete: manual server creation and SSH setup
were outside that timer; the chosen snapshot was from the previous day and was
not a demonstration of a one-hour recovery-point objective; the original database
was small and lacked customer bookings; and production integrations and invite-only
configuration were not exercised. A production acceptance drill should measure
from incident declaration through service restoration and include representative
encrypted records already present in the off-host backup.

We now have evidence spanning scheduling, alerts, off-host storage, independent
keys, source builds, application behavior and browser access. The next rehearsal
can follow the same sequence with a recent snapshot and a representative dataset.

## Supporting implementation and evidence

- [Backup-monitor implementation and acceptance evidence](backup-monitor.md)
- [Staging backup and restore runbook](staging-backup-recovery.md)
- [September 24 isolated and vault-sourced drills](staging-recovery-drill-2026-09-24.md)
- [September 25 clean-host and HTTPS/browser evidence](staging-clean-host-recovery-2026-09-25.md)
- [Production deployment acceptance checklist](production-deployment-tasklist.md)

The one-off execution helpers and raw local reports were kept in ignored
`docs/tmp/`; this article is a walkthrough of the recorded exercise, not a standalone
automated recovery installer. The linked runbooks and tracked backup scripts are
the durable operational references.
