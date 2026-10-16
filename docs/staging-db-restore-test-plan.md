# Staging database restore test — plan

**Status: planned 2026-10-16, not yet run.** First monthly repeat of the restore
drill required by [staging backup and recovery](staging-backup-recovery.md) §6 and
[production launch](production-launch.md) step 6. Results go in §7 of this file.

## 1. What is already proven, and what this test is for

Two drills passed: the [application drill](staging-recovery-drill-2026-09-24.md)
on the staging VPS (24 September) and the
[clean-host recovery](staging-clean-host-recovery-2026-09-25.md) with rebuilt
images and HTTPS/browser checks (25 September). Both restored **the same
snapshot**, taken 2026-09-24 14:30 UTC, which held one user, no tenants and no
bookings. Both checked row counts only. This test does **not** repeat the clean-host or
browser path. It closes the gaps those drills recorded:

| Gap | Why it is still open                                                                                                                                        | Test   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| G1  | Recovery point never measured: both drills reused a snapshot that was hours or a day old.                                                                   | T1     |
| G2  | No historical ciphertext restored: encrypted rows were synthetic, created after the restore.                                                                | T6     |
| G3  | Schema checked by migration count only, not compared with the release's schema; the booking exclusion constraint (rule 14) was never checked after restore. | T3     |
| G4  | Data checked by row counts only: a restore with the right counts and the wrong contents would have passed.                                                  | T4, T5 |
| G5  | Retention never exercised: only the newest snapshot was ever restored, never a 30-day daily copy.                                                           | T8     |
| G6  | `restore-rehearsal.sh` has no tests; its refusals (name guard, occupied target) were never run.                                                             | T9     |
| G7  | Repository integrity last read in full on 2026-09-21.                                                                                                       | T10    |

Out of scope: production (its own gate, and no production data exists yet), Redis
(rebuilt from PostgreSQL, proven twice), image rebuilding and HTTPS (proven
25 September), and the four-hour total (proven only with the clean-host path; record
this test's times, but do not claim the gate from them).

## 2. Ground rules

The restored database holds real staging PII once staging has customers. Treat it
like staging itself.

1. **Never touch staging's database or volumes.** Every target is a new PostgreSQL
   18 container, same image digest as staging, with its own volume, on an
   `--internal` Docker network, no published ports, `traefik.enable=false`, and the
   label `bam.drill=restore-YYYYMMDD`. Database names start with `bam_rehearsal_`
   (the script refuses anything else).
2. **No outbound traffic from the restored applications.** Email, Stripe, Billingo,
   Google, AI and Sentry settings blank; prove egress is blocked with a TCP probe
   before starting the API or worker, as in the 24 September drill.
3. **Read-only on R2.** Only `restic snapshots`, `dump`, `ls` and `check`. Never
   `forget`, `prune`, `tag`, `unlock` or `init`.
4. **Stay clear of the backup's lock.** The staging backup runs at :00 and :30 and
   ends with `restic forget --prune`, which needs an exclusive repository lock. A
   `restic dump` or `check` running then makes the backup fail at the `retention`
   stage, and the monitor emails a real failure alert. Start each R2 step between :05
   and :25 or :35 and :55. Pass `--no-lock` to the `snapshots` and `ls` commands
   you run by hand. `restore-rehearsal.sh` calls `restic dump` without it, so for T2
   and T8 the time window is the only protection.
5. **Never send check-ins to the backup monitor** from the drill, and no fabricated
   events. The monitor must keep seeing only real backups.
6. **Secrets come from KeePassXC** (`Booking-and-more-Staging`) over SSH stdin, as in
   the vault-sourced rerun. Never put them in arguments, environment files or the
   transcript. PII is never printed: every check reports counts and hashes only.
7. **Abort** if any staging service turns unhealthy, an egress probe succeeds, a
   backup alert or heartbeat `/fail` arrives, or a command would write to a
   database not labelled for this drill. Clean up (T12), then record why.

## 3. Preconditions

- [ ] The backup monitor's cron is running again: healthchecks.io shows `ok` pings
      every 5 minutes after the 2026-10-16 alert test. Do not start without it.
- [ ] D1 shows `reason=null` and a `last_success` under 30 minutes old (query in
      [backup-monitor.md](backup-monitor.md)).
- [ ] SSH alias `hetzner` works; the KeePassXC vault opens.
- [ ] Free disk on the VPS is at least 3× the dump size plus 5 GB; record it.
- [ ] Record the running staging release SHA (`/health` or Coolify) and its
      PostgreSQL image digest. T3 uses that SHA's `schema.prisma` and migration
      folder, not this branch's.
- [ ] Real ciphertext is seeded and backed up: see §3.1.

### 3.1 Seed real ciphertext (closes G2)

On 2026-10-16 staging held no customers or bookings, so no backup contained
encrypted customer data. Create it through the deployed product, never by SQL, so
the API encrypts it and the real backup stores it:

- An ACTIVE organization with at least two providers and one service. If none
  exists, provision one through `/platform` first; staging's billing mode decides
  whether that needs a Stripe test subscription.
- **8 bookings through the public booking page**, spread over both providers.
  Customer addresses must be the operator's own aliases
  (`hajzerbela+drill1@gmail.com` … `+drill8`). Confirmation emails really are
  sent, so never use anyone else's address.
- At least one customer name with Hungarian accents (`Árvíztűrő Tünde`) to check
  encoding through dump and restore. Reschedule one booking and cancel one, so the
  restore contains more than one booking state.
- At least one appointment **after 2026-10-25**, when Budapest leaves summer time.
  T5 then compares an instant on each side of the change.
- Record the booking references and the time of the last write. Do not record
  names or addresses. T0 uses the first backup promoted **after** that time.
- Leave the bookings in place afterwards, so the next monthly drill restores older
  ciphertext as well.

## 4. Tests

Number the run `restore-YYYYMMDD`. Record UTC times for every step.

**T0 — Live baseline.** Immediately after a :00 or :30 backup is promoted (journal
shows the snapshot), record on **live staging**, read-only: exact row count per
table, a per-table content hash
(`md5(string_agg(t::text, '' ORDER BY <primary key>))`), `max(updated_at)` or
`max(created_at)` where the column exists, the `_prisma_migrations` list, extensions,
and the constraint and index inventory from `pg_constraint` and `pg_indexes`. Stage it
as a script so T4 can run the same queries against the restore.

**T1 — Recovery point.** Select that newest `bam-staging` snapshot
(`restic snapshots --no-lock --tag bam-staging --latest 1`). Record its ID and time.
**Pass:** the snapshot is under 60 minutes old when the restore starts, and no
`bam-staging-pending-*` snapshot is newer.

**T2 — Restore.** Run `restore-rehearsal.sh` with that `SNAPSHOT_ID` into
`bam_rehearsal_<date>`. The script's own message mentions `--tag bam-production`;
on staging use `bam-staging`. **Pass:** exit 0, `pg_restore --exit-on-error`
reported nothing, and the elapsed time is recorded.

**T3 — Schema fidelity.** Against the restored database:

- `prisma migrate diff --from-url <restored> --to-schema-datamodel <schema.prisma at
the staging SHA> --exit-code` → exit 0. This is the same check as `db:drift-check`,
  aimed at the restore instead of a fresh migrate.
- Every `_prisma_migrations` row has `finished_at` set and `rolled_back_at` null,
  and the list equals the migration folders at that SHA.
- Extensions and the constraint/index inventory equal T0's. In particular, the
  `EXCLUDE USING gist` constraint on `capacity_reservations` exists with
  `convalidated = true`.

**Pass:** all three hold.

**T4 — Data fidelity.** Rerun T0's queries on the restore. **Pass:** for every table,
the counts and hashes are equal, or the difference is explained by rows whose
`created_at` or `updated_at` is later than the snapshot time. List every explained
table. An unexplained difference fails the test.

**T5 — Instants (rule 13).** Pick ten timestamptz values, such as booking starts,
`availability_exceptions`, outbox `available_at` and invitation expiry. Compare
`extract(epoch from …)` on live and restored. Compare epochs, not formatted dates;
formatted dates are what hid the original timezone bug.
**Pass:** all ten are identical, and `SHOW timezone` on the restored container
reports `UTC`.

**T6 — Historical ciphertext.** Start the staging API and worker images on the drill
network, with the vault's `BETTER_AUTH_SECRET`, `CUSTOMER_PII_ENCRYPTION_KEY` and
`CUSTOMER_PII_BLIND_INDEX_KEY` and every integration blank. Then:

- API readiness passes.
- Every restored customer decrypts. Report the count of successes and failures,
  never values.
- Recomputing each customer's email blind index from the decrypted email
  reproduces the stored index. Report the count.
- One real booking reads back through the API with its customer name decrypted.
  Assert equality with live staging's response by hash.
- A wrong key is rejected.

**Pass:** zero failures, and the restored customer count equals the §3.1 seed
(8, plus any created since). A count of zero means the seed missed the snapshot:
stop, and pick a later backup rather than recording G2 as closed.

**T7 — Behaviour on restored data.** For one tenant and one fixed date, run
`pnpm db:explain-availability <slug> <date>` against live and against the restore.
The script is read-only. **Pass:** the verdicts and slot lists are identical.

**T8 — An old daily copy.** Select the oldest retained daily snapshot, at least
14 days old, and restore it into a second database, `bam_rehearsal_<date>_old`.
**Pass:** the restore exits 0, the migration rows match what was deployed then, and
`restic snapshots` shows the retention shape the script promises: every snapshot
within 7 days, then one per day up to 30 days.

**T9 — Script refusals (G6).**

- Rerun T2 into the now-occupied `bam_rehearsal_<date>`. Expect a non-zero exit,
  and the T4 counts unchanged afterwards.
- Run with `RESTORE_DATABASE=staging_copy`. Expect the name-guard refusal before
  anything is read from R2.
- Run with a wrong `RESTIC_PASSWORD_FILE`. Expect a non-zero exit with nothing
  restored.

Afterwards, add these three cases to `ops/production/test-backup.py`, or a sibling
test file, so they stay tested.

**T10 — Repository integrity.** Run `restic check --read-data` if the repository is
under 2 GB, otherwise `--read-data-subset=10%`. Keep it inside the window from §2.4.
**Pass:** no errors.

**T11 — Staging continuity.** All staging services are healthy, their image IDs
are unchanged, and the next scheduled backup succeeds. D1 shows no incident, and
healthchecks.io shows only `ok` pings for the drill's duration.

**T12 — Cleanup.** Remove every container, volume and network labelled
`bam.drill=restore-YYYYMMDD`, and verify they are gone. Verify no plaintext dump or
`.sql` file exists on the VPS: the restore streams, so none should. Remove any
temporary local copy of a secret.

## 5. Timing

Record each of these in UTC:

- decision to start;
- secrets retrieved;
- containers ready;
- restore start and end;
- T3–T7 end;
- cleanup end.

Report the restore duration and the start-to-validated duration separately. Both
are VPS-local and exclude provisioning, so they show only that the database step
fits easily inside the four-hour target, not the target itself.

## 6. After the test

1. Fill in §7. Keep it free of credentials and PII: identifiers, counts, hashes and
   times only.
2. Update the "ongoing recovery checks" in
   [staging-backup-recovery.md](staging-backup-recovery.md) and the recovery line
   of the [deployment tasklist](production-deployment-tasklist.md). Mark each gap in
   §1 closed or still open.
3. Commit the T9 test cases. Fix the `bam-production` wording in
   `restore-rehearsal.sh`'s `SNAPSHOT_ID` message, which is misleading on staging.
4. Schedule the next monthly repeat for about 2026-11-16. Copy this file's §4 as its
   checklist, not the September drill records.

## 7. Results

_Not yet run._

| Test | Result | Evidence (IDs, counts, hashes, UTC times) |
| ---- | ------ | ----------------------------------------- |
| T0   |        |                                           |
| T1   |        |                                           |
| T2   |        |                                           |
| T3   |        |                                           |
| T4   |        |                                           |
| T5   |        |                                           |
| T6   |        |                                           |
| T7   |        |                                           |
| T8   |        |                                           |
| T9   |        |                                           |
| T10  |        |                                           |
| T11  |        |                                           |
| T12  |        |                                           |
