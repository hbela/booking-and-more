# Staging recovery drill — 2026-09-24

**Status: technical recovery exercised; full server-loss recovery acceptance remains open.**
The exercise recovered the application from an encrypted off-host database backup
on the existing VPS. It reused secrets and cached images from the surviving server.
An independent secret/configuration recovery copy has not yet been identified or tested.

Final successful run: `2026-09-24T14:46:39.797760Z`–`14:48:00.026994Z`
(16:46:39–16:48:00 Budapest time). Technical recovery and validation took **78.97
seconds**; including cleanup, **80.23 seconds**. This timer excludes preparation,
earlier attempts, independent secret retrieval and new-host/image provisioning;
it is not a complete server-loss recovery-time measurement.

Credential-free raw report on the VPS:
`/var/backups/bam-recovery-drill/bam-recovery-20260924144639/report.json`.
All drill-owned containers, volumes and networks were removed and absence verified.

## Source and isolation

- Staging release reported by the running API: `8be3b269b0c20b1d15ad4f1b838f151f6b37d875`.
- Selected recoverable Restic snapshot:
  `5185871c39c19764b5d50dc09d4d10af138098c4d05b3003fd11d0dbbca62bef`.
- Snapshot timestamp: `2026-09-24T14:30:03.198241611Z`; tag: `bam-staging`.
- Snapshot source: encrypted R2 staging repository; no new backup repository was created.
- Restored into newly created PostgreSQL and Redis volumes on a dedicated Docker
  internal network, with no published ports and `traefik.enable=false`.
- API, worker and web used the existing image IDs, with resource limits. Staging
  containers, writable volumes, queues and routing were not reused by the restored stack.
- Email, Stripe, Billingo, Google, AI and Sentry credentials were absent or explicitly
  blank in the restored applications. A TCP probe confirmed outbound connectivity
  to `1.1.1.1:443` was blocked. No notification was marked sent.
- Secret values were passed in process environments, not printed, written to
  environment files, or placed in command-line arguments.

| Service    | Image ID used                                                             |
| ---------- | ------------------------------------------------------------------------- |
| API        | `sha256:a7c83168918e0d64af53f11d6788b5dd8d48fe32b782d6ef8b74f9ee8198addd` |
| Worker     | `sha256:3cfc8dbf1f45d9f3ebcdd5272f6dd51579e2e17eca45618a3c2f48b8cf30ca06` |
| Web        | `sha256:f57baaa853496c07bfaf607753101a9ef37a4550ae838041e1b72dd1449e0011` |
| PostgreSQL | `sha256:6def1cb8d5ffa3443c527419cc13f395ab328c27bf90fcb1e80831aae4103bc3` |
| Redis      | `sha256:59c08762bdbcf53fa132aa0bae464a57a1309dc3fff8a034bb3e16d7a0b30ec5` |

## Results

| Check                     | Evidence                                                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Off-host database restore | Restic streamed the selected R2 snapshot into an empty PostgreSQL 18 database; dump and restore processes both succeeded.                                                                                                    |
| Baseline data             | One user, zero tenants/customers/bookings, and 42 migration records, matching the inspected staging counts. No unfinished migration remained.                                                                                |
| Application startup       | Restored API readiness passed with its own database and Redis; web health and Hungarian/English sign-in page rendering passed.                                                                                               |
| Encryption                | Synthetic customer and booking records were created only in the restored copy, then dumped and restored into a second rehearsal database. Customer fields and booking snapshots decrypted correctly afterward.               |
| Matching indexes          | Restored email blind index matched the decrypted email and original tenant; the same email under another tenant produced a different index.                                                                                  |
| Invalid keys              | Wrong decryption key was rejected; missing encryption or blind-index keys failed configuration validation.                                                                                                                   |
| Application data read     | API was restarted against the second restored database and returned the synthetic booking with its expected decrypted customer name and reference.                                                                           |
| Authentication            | Synthetic account signup, password sign-in and authenticated session retrieval succeeded in the restored database. No existing account password was changed.                                                                 |
| Redis loss recovery       | A pending synthetic notification was rebuilt as a delayed queue job from PostgreSQL with initially empty Redis. After stopping the cloned worker and clearing only its Redis database, worker restart rebuilt the job again. |
| Staging continuity        | All five original staging services remained healthy with unchanged image IDs and aggregate data counts; the original backup timer remained active.                                                                           |

The source snapshot contains no representative customer or booking data. The
encrypted-record checks therefore used synthetic data added **after** the R2
restore. Their second dump/restore was local to the isolated stack; it was not
another R2 recovery, and it does not prove recovery of historical customer records.

## Configuration findings and limits

The initial attempt restored the database but the API refused to start:
`NODE_ENV=production` with invite-only access requires verification-email delivery.
The isolated rerun retained production runtime mode but used `LAUNCH_ACCESS_MODE=public`
to allow all email credentials to remain disabled. This applied only to inaccessible
drill containers. Staging's invite-only policy was unchanged; launch access controls
were not acceptance-tested by this recovery drill.

The recovered web image retains its build-time browser API origin. Web checks used
internal HTTP requests to health and sign-in pages; the browser application was not
opened against that image. Recovery under a different public origin requires a
matching rebuilt image or an isolated HTTPS setup before browser acceptance.

No real payments, invoices, emails, calendar writes or customer notifications were
attempted. Their live delivery is a separate acceptance test. A delayed synthetic
notification proved queue reconstruction without invoking its email delivery.

## Remaining full-recovery acceptance

1. Identify the operator's independently stored recovery copy of the Restic password,
   R2 access credentials, authentication secret, both distinct PII keys, and application
   configuration. Retrieve it without relying on the original VPS. The local root
   `.env` contains an authentication-secret entry but no PII-key or Restic/R2 entries;
   it has not been validated as a staging recovery source.
2. Prove the selected application images can be recovered from an independent
   registry/artifact source or rebuilt from the recorded revision. This exercise
   used images already cached on the VPS.
3. Repeat the timed end-to-end drill using those independent recovery sources,
   including provisioning, secret retrieval, application validation and the intended
   HTTPS/browser path. Record the total against the four-hour recovery target.
4. Repeat with representative encrypted staging data when available and assess
   realistic data volume. The small current database does not establish production
   restore performance.

Do not mark the production recovery gate complete from this staging exercise.
