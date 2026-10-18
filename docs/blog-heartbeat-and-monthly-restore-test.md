# Who watches the backup monitor? Plus our first monthly restore test

_Booking and More · October 13–17, 2026_

Our [September recovery drill](blog-backup-acceptance-and-recovery-drill.md)
ended with a list of things it had not proven:

- The snapshot it restored was a day old.
- The database held no customer data.
- The only data checks were row counts.

There was also a gap the drill never touched: our backup monitor could alert us
about backups, but nothing would alert us if the monitor itself stopped.

This post covers the week we spent closing those gaps, in two parts.

1. **A heartbeat for the monitor.** It took one small function and one rule:
   check that the first ping actually arrives.
2. **A restore test that checks the data, not just that the restore ran.** We
   restored a 35-minute-old snapshot in 6.2 seconds. All 45 tables matched live by
   content hash. The encrypted customer data decrypted to exactly what live staging
   holds, and the restored application gave the same answers as the real one.

Along the way we caused ourselves a 74-minute monitoring outage while testing an
alert. That story is in Step 5, and it's why our alert test now works differently.

The commands below are the ones we used. Run pnpm commands from the repository
root, and Linux commands on the staging VPS. **Every secret in this post travels
through a pipe or a protected prompt. None appears in a command line, a file in
Git, or this text.**

## The system, briefly

| Component                                | Job                                                             |
| ---------------------------------------- | --------------------------------------------------------------- |
| systemd timer on the VPS                 | Back up PostgreSQL at :00 and :30                               |
| `pg_dump -Fc` → Restic → Cloudflare R2   | Encrypted, off-host snapshots; 7 days of all, 30 days of daily  |
| Cloudflare Worker + D1, cron every 5 min | Detect failed, missing (50 min) or overrunning (20 min) backups |
| Resend                                   | Send the alert and recovery emails                              |
| **healthchecks.io** (new)                | Alert when the Worker itself goes quiet                         |
| KeePassXC                                | Hold every recovery secret, independent of the server           |

---

## Part 1: watch the watcher

### Step 1 — Find what nothing is watching

Ask what happens if each part of the chain fails:

| If this stops…              | Who tells you?                                                         |
| --------------------------- | ---------------------------------------------------------------------- |
| The backup job              | The Worker: no success for 50 minutes                                  |
| The VPS                     | The Worker: same                                                       |
| **The Worker's cron**       | **Nobody.** No code runs, so nothing is sent                           |
| **Resend (the email path)** | **Nobody.** Alerts wait in D1, and the only trace is a `console.error` |

Our error tracker didn't cover this either. The monitor Worker has no Sentry SDK,
and our free Sentry plan's only cron monitor was already used for the application
worker. A monitor can't report its own death. Something outside it has to notice
the silence.

### Step 2 — Add a dead-man's switch

A dead-man's switch is a service that expects regular pings and alerts you when
they **stop**. We chose healthchecks.io: it's free, and it runs independently of
Cloudflare, Hetzner and Resend.

The Worker now pings at the end of every scheduled check, and sends one of three
signals:

- **Success:** the check ran and every alert email has been delivered.
- **`/fail`:** the check threw, or an alert has gone undelivered for 15 minutes.
- **Nothing:** the cron stopped. healthchecks.io notices on its own.

The heart of it:

```ts
async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  let failure: string | undefined;
  try {
    await evaluate(env, now);
    await deliver(env, now);
    if (await undeliveredAlerts(env, now)) failure = "Backup alert email undelivered";
  } catch (error) {
    failure = "Scheduled backup check failed";
    throw error;
  } finally {
    await heartbeat(env, failure); // never throws
  }
},
```

Two design choices are worth copying:

- **The ping can never break the check.** `heartbeat()` catches and logs
  everything, so an outage at healthchecks.io can't hide or replace the real
  result.
- **"Stuck" is measured from when the alert was created, not from its last
  attempt.** Our first version used the retry timestamp, which the same run had
  just updated, so a 15-minute-old alert looked brand new. A test caught it before
  it shipped.

On healthchecks.io, set the check's period to **5 minutes** and its grace to
**10 minutes**.

### Step 3 — Store the secret so it can't arrive blank

The ping URL is a credential: anyone who has it can send fake "all good" pings.
So it goes into the Worker as a secret:

```text
wrangler secret put HEARTBEAT_URL --config wrangler.jsonc
```

Our first attempt went wrong in two ways at once:

- The prompt received **an empty value**.
- A second attempt put the URL in the **name** field, creating a secret _named
  after_ the URL.

Neither produced an error. The Worker treats an empty URL as "heartbeat
disabled" and stays silent. healthchecks.io stayed silent too, because **a new
check doesn't alert until it has received its first ping**. Both sides looked
fine while nothing worked.

The fix is to pipe the value in, so the prompt can't take a blank:

```bash
printf '%s' 'https://hc-ping.com/<your-check-uuid>' \
  | wrangler secret put HEARTBEAT_URL --config wrangler.jsonc
```

Then list the secret **names** to catch typos like ours:

```text
wrangler secret list --config wrangler.jsonc
```

### Step 4 — Don't trust it until the first ping arrives

On the check's page in healthchecks.io you should see, within five minutes:

```text
HTTPS POST from 172.69.x.x   body: ok
```

The source address is in Cloudflare's range, and the body is the string the code
sends on success. Until you see that line, you have built a heartbeat, not
installed one.

### Step 5 — Test the alert, but don't remove the cron

To prove the "down" email really arrives, the Worker has to go quiet. Our first
method was to deploy with an empty cron list and redeploy the real one 15 minutes
later. **Don't do this.** Here's what happened:

| UTC         | Event                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| 17:08       | Deployed `"crons": []`                                                 |
| 17:08–17:31 | Pings **continued**: the removal hadn't taken effect                   |
| 17:31       | Restored `*/5 * * * *`. The delayed removal then seems to have won     |
| 17:46       | healthchecks.io: `up → down`. **The alert email arrived: test passed** |
| 17:51       | Pushed the trigger again: nothing                                      |
| 18:10       | Pushed a new, equivalent expression: nothing                           |
| 18:29       | Cleared the schedule through the API, waited, re-added it: nothing     |
| 18:42       | **Full `wrangler deploy`**                                             |
| 18:45       | First ping. The "up" email arrived                                     |

For **74 minutes**, the API listed the schedule as attached while nothing fired.
In that time a _failed_ backup would still have alerted us, because each VPS
check-in runs the same evaluation as the cron. But if the server had simply gone
silent, nobody would have known.

Three lessons came out of it:

1. **Trigger changes can take 15+ minutes to take effect,** and a removal that
   lands late can win over the re-add that came after it.
2. **When a cron is attached but not firing, redeploy the whole Worker.** Pushing
   only the trigger never helped.
3. **Cloudflare's scheduled-invocation analytics lagged.** That data still showed
   no runs after pings had resumed. healthchecks.io, the outside witness, was right
   throughout.

The safe way to test is to **silence the heartbeat, not the cron**. Store an empty
`HEARTBEAT_URL`, wait for the "down" email, then pipe the real URL back in. The
backup checks keep running the whole time.

---

## Part 2: a restore test that checks the data

### Step 6 — Write down what you're trying to prove

The two September drills had both restored the same day-old snapshot of an almost
empty database, and checked row counts. We listed what that left open, and gave
each gap a test:

| Gap                                                     | Test                                      |
| ------------------------------------------------------- | ----------------------------------------- |
| How much data would a real restore lose?                | Restore the newest snapshot; under 60 min |
| Does the schema match what the release expects?         | `prisma migrate diff` against the release |
| Could the right row counts hide the wrong contents?     | Compare a content hash per table          |
| Are timestamps intact, on both sides of a clock change? | Compare raw epoch values                  |
| Does _historical_ encrypted data decrypt?               | Decrypt rows written before the backup    |
| Does the restored app behave like the real one?         | Compare its API answers with live         |
| Do older snapshots still restore?                       | Restore the oldest daily copy             |
| Does the restore script refuse dangerous input?         | Run its three refusals                    |
| Is the repository itself intact?                        | `restic check --read-data`                |

Writing this first kept the drill honest: every check maps to a question, and
"the restore exited 0" answers only one of them.

### Step 7 — Seed real encrypted data, through the product

An empty database can't prove that encrypted data survives. So before the test we
made eight bookings **through the public booking page**, not by SQL. That way the
real API encrypted them, and the real backup carried them to R2:

- the customer addresses were the operator's own `+drill1` … `+drill8` aliases,
  because confirmation emails really go out;
- one name had Hungarian accents (`Árvíztűrő Tünde`), to test text encoding;
- one booking was rescheduled and one cancelled;
- one appointment was after 25 October, when Budapest leaves summer time.

We counted the results, and the counts were off. Eight bookings had produced
**no new customers**: the booking flow matches a returning customer on email
**or phone**, and we had typed the same phone number every time. That's correct
product behaviour, and it taught us a test-data rule: **use a different phone
number for each fake customer.** Each booking still keeps its own encrypted copy of
the customer's name, so we still had 17 historical encrypted names to test.

### Step 8 — Move the secrets from the vault to the server, without seeing them

The restore needs seven secrets: the restic password, the R2 address and both of
its keys, the authentication secret, and both customer-data encryption keys. The
operator ran one command per secret in **cmd.exe**, which passes the bytes through
the pipe untouched:

```bat
set KP="C:\Program Files\KeePassXC\keepassxc-cli.exe" show -s
set DB="<path-to>\Passwords.kdbx"

%KP% -a Password %DB% "Booking-and-more-Staging/Restic repository password" ^
  | ssh hetzner "umask 077; tr -d '\r\n' > /run/bam-drill/restic-password"
```

The values flow from the vault, through SSH, into root-only files under `/run`,
which lives in RAM. They never appear on screen, in shell history or in a
transcript. Then we **checked them without printing them**, by comparing hashes:

```bash
[ "$(sha256sum < /run/bam-drill/pii-encryption-key)" = \
  "$(printf '%s' "$LIVE_VALUE" | sha256sum)" ] && echo "matches staging"
```

All seven matched the running staging configuration. One surprise: the restic
password lived in an entry that didn't show up in our first listing of the vault
group, so the first attempt produced an empty file. The size check caught it at
once (`restic-password 0 bytes`).

### Step 9 — Stay out of the backup's way

The backup runs at :00 and :30 and ends with `restic forget --prune`, which needs
an **exclusive** lock on the repository. Any `restic` read during that moment makes
the backup fail, and the monitor would email a real failure alert caused by the
test itself.

So every step that reads from R2 started between **:05–:25** or **:35–:55**, and
the snapshot listings used `restic --no-lock`. It cost nothing, and the 16:00
backup afterwards succeeded normally.

### Step 10 — Fingerprint live staging first

Right after the 15:00 backup, we took a read-only fingerprint of live staging.
One generated query per table counts the rows and hashes their entire contents:

```sql
SET default_transaction_read_only = on;
SET timezone = 'UTC';
SELECT format(
  'SELECT %L, count(*), md5(coalesce(string_agg(t::text, E''\n'' ORDER BY t::text), '''')) FROM %I.%I t',
  table_name, table_schema, table_name)
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE' \gexec
```

The same script also records the migrations, extensions, all constraints and
indexes (as hashes), every booking's start and end as raw epoch values, and each
table's latest write time. That last part showed **nothing had been written since
15:00**, so live staging and the snapshot were identical. Without that, every
difference later on would have needed explaining away.

### Step 11 — Restore into a sealed container

The target was a fresh PostgreSQL container from **the same image ID** staging
runs, on an internal-only Docker network with no published ports:

```bash
docker network create --internal --label bam.drill=restore-20261017 bam-drill-20261017
docker run -d --name bam-drill-20261017-pg --label bam.drill=restore-20261017 \
  --network bam-drill-20261017 -v bam-drill-20261017-pg:/var/lib/postgresql \
  -e POSTGRES_PASSWORD="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
  <staging-postgres-image-id>
```

Then the existing restore script streamed the 15:00 snapshot from R2 straight
into `pg_restore`. No plaintext dump touched the disk:

```text
T2 start 15:35:00.106Z
Restore completed in 6s
T2 end   15:35:06.302Z    exit=0
```

The recovery point was 35 minutes: the time between the snapshot and the start of
the restore. Our target is under 60.

### Step 12 — Compare the schema with the release, not with a guess

A restored schema should be exactly what the running release expects. We ran
Prisma's own drift check from a throwaway container of the **staging API image**,
which carries that release's `schema.prisma`, on the sealed network:

```bash
docker run --rm --network bam-drill-20261017 --entrypoint "" -w /app/packages/db \
  -e DATABASE_URL="postgresql://postgres:…@bam-drill-20261017-pg:5432/bam_rehearsal_20261017" \
  <staging-api-image> node_modules/.bin/prisma migrate diff \
  --from-config-datasource --to-schema ./prisma/schema.prisma --exit-code
```

```text
No difference detected.
```

All 504 constraints matched live as well, including the two exclusion
constraints that stop double bookings, and so did all 150 indexes.

### Step 13 — Compare the data itself

We reran the Step 10 fingerprint on the restore and compared the outputs:

```text
T4: all 45 tables identical (count and md5)
T5: all 17 bookings' start/end epochs identical
    starts before 2026-10-25T01:00Z: 12, after: 5
```

The epoch comparison deserves a note. A restore that shifted every time by an hour
would still look right when read back through an ORM. Comparing raw epoch values,
inside the database, is what would expose such a shift. All 17 matched, and the
restored session reported `UTC`.

### Step 14 — Decrypt the historical data and compare it with live

This is the check the September drill couldn't do. A throwaway Node container
from the staging image, **with no network at all** (`--network none`), received
the restored ciphertext on stdin. It decrypted every value with the vault keys,
recomputed the search hashes, tried a random wrong key, and printed only counts
and one digest over all the plaintext:

```json
{
  "customers": {
    "customers": 2,
    "fields": 5,
    "failed": 0,
    "emailIndexOk": 2,
    "phoneIndexOk": 1,
    "accented": 1
  },
  "bookings": { "snapshots": 17, "failed": 0, "accented": 10 },
  "wrongKeyAccepted": 0,
  "plaintextDigest": "cc8ba4ef…"
}
```

The same script against **live** staging produced the same digest. The restore
decrypts to exactly the same data, and no name, address or phone number was ever
printed.

Two practical snags, both easy to hit:

- The image runs as a non-root user, so it couldn't read the root-only secret
  files. We ran this one container with `--user 0`, which is acceptable only
  because it has no network.
- `docker exec -i` inside a script fed to `bash -s` **reads the rest of the
  script from stdin**, so the script silently ended early. Give such commands
  `< /dev/null`.

### Step 15 — Run the app on the restore and ask it the same questions

Finally we started the staging API image itself against the restore, with:

- the vault secrets;
- a new, empty Redis;
- every outside integration removed.

First we proved the network was sealed:

```text
egress probe to 1.1.1.1:443: blocked (ENETUNREACH)
/health/ready → 200 {"postgres":"ok","redis":"ok"}
```

The first start failed, which we count as a good sign. The configuration check
refused because `EMAIL_FROM` and the Billingo settings were still present without
their keys. Removing a credential isn't enough; its dependent settings have to go
too.

Then we sent the same public requests to the restored API and to live, and
compared hashes of the responses:

| Request                          | Restored               | Live                   |
| -------------------------------- | ---------------------- | ---------------------- |
| `GET /v1/public/tenants/:slug`   | `a147855d…`            | `a147855d…`            |
| `GET …/services`                 | `7ba2035d…`            | `7ba2035d…`            |
| `GET …/providers`                | `649a336b…`            | `649a336b…`            |
| `POST …/slots/search`, 19–30 Oct | 600 slots, `0df3e2b4…` | 600 slots, `0df3e2b4…` |

The slot search is the strongest result. It runs the real availability engine,
and the restored bookings blocked exactly the same 600-slot pattern as the live
ones, across a clock change.

### Step 16 — Restore the oldest copy, test the refusals, read everything

Three shorter checks, all inside the same 20-minute window:

- **Oldest daily copy:** the snapshot from 21 September, 26 days old, restored in
  4 s with 42 migrations, as recorded at the time. The retention shape was
  correct: every snapshot for 7 days, then exactly one per day.
- **Refusals:**
  - a database name without the `bam_rehearsal_` prefix is refused in 7 ms,
    before anything is read;
  - a wrong restic password fails with `wrong password or no key found`;
  - a rerun into the already-full target stops at the first existing object, and
    leaves the restored data untouched.
- **Full read:** `restic check --read-data` read all 35 packs (36 MiB) in 14 s:
  `no errors were found`.

### Step 17 — Prove you left nothing behind

We removed everything carrying the drill's label, including the seven secrets in
`/run/bam-drill`, and verified it:

```text
left: containers=0 volumes=0 networks=0
/run/bam-drill removed
dump/sql files modified in the last 2h: 0
```

The 16:00 backup then ran normally and the monitor showed no incident. The
heartbeat had sent only `ok` throughout, so the test hadn't disturbed anything it
was testing.

### Step 18 — Make sure it happens again

A drill that only works once proves very little. We did three things:

- turned the three refusals into a test file that CI runs;
- recorded the results and the lessons next to the plan, so next month starts from
  the checklist rather than from memory;
- put the next run in the calendar for **16 November**.

---

## What the results establish

| Question                                 | Answer                                    |
| ---------------------------------------- | ----------------------------------------- |
| Does the monitor report its own outage?  | Yes: healthchecks.io alerted on silence   |
| How much data would a restore lose?      | 35 minutes in this run (target: under 60) |
| How long does the database restore take? | 6.2 seconds                               |
| Is the schema what the release expects?  | Yes: no difference                        |
| Is the data identical?                   | Yes: all 45 tables, by content hash       |
| Does historical encrypted data decrypt?  | Yes, to the same digest as live           |
| Does the restored app behave the same?   | Yes: byte-identical public answers        |
| Do old snapshots restore?                | Yes: the 26-day-old copy                  |
| Is the repository intact?                | Yes: full read, no errors                 |

And the limits, stated as plainly:

- **Only two customers were exercised** in the decryption test, because of the
  shared phone number.
- **No staff login was tested** against the restore. We read it through the public
  API only.
- **The four-hour target wasn't re-measured.** The September clean-host drill
  remains the evidence for that, and this test's times are VPS-local.
- **This is staging.** Production will need its own run, against its own
  repository.

## The short version

If you take only five things from this post:

1. **Put an outside heartbeat on your monitor,** and don't trust it until you've
   seen its first ping arrive.
2. **Test an alert by silencing the signal, not by removing the scheduler.**
3. **Fingerprint live data before you restore,** so that "identical" is something
   you can check, not just believe.
4. **Decrypt the historical data,** and compare the result with live by hash, so no
   plaintext needs printing.
5. **Ask the restored application the same questions as the real one,** and
   compare the answers.

## Supporting records

- [Backup monitor, including the heartbeat and the cron outage](backup-monitor.md)
- [The restore test plan and its full results](staging-db-restore-test-plan.md)
- [Staging backup and recovery runbook](staging-backup-recovery.md)
- [September's drill, the predecessor of this one](blog-backup-acceptance-and-recovery-drill.md)
