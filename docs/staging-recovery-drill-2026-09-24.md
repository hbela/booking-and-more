# Staging recovery drill — 2026-09-24

**Status: technical recovery exercised; full server-loss recovery acceptance remains open.**
The exercise recovered the application from an encrypted off-host database backup
on the existing VPS. The first run reused secrets and cached images from the
surviving server. A subsequent run retrieved recovery credentials from the off-VPS
KeePassXC vault (`Passwords.kdbx`, group `Booking-and-more-Staging`) and passed
all technical checks. Both runs used cached images on the existing VPS.

First successful run: `2026-09-24T14:46:39.797760Z`–`14:48:00.026994Z`
(16:46:39–16:48:00 Budapest time). Technical recovery and validation took **78.97
seconds**; including cleanup, **80.23 seconds**. This timer excludes preparation,
earlier attempts, independent secret retrieval and new-host/image provisioning;
it is not a complete server-loss recovery-time measurement.

Credential-free raw report on the VPS:
`/var/backups/bam-recovery-drill/bam-recovery-20260924144639/report.json`.
All drill-owned containers, volumes and networks were removed and absence verified.

## Vault-sourced rerun

The rerun at `2026-09-24T15:33:58.900796Z`–`15:35:19.401293Z`
(17:33:58–17:35:19 Budapest) passed in **79.21 seconds**, or **80.50 seconds**
including cleanup. This timing excludes vault retrieval, preparation and clean-host
provisioning, so it does not establish the full four-hour recovery target.

- Retrieved Restic password, both R2 credentials and the repository address from
  KeePassXC; the address was in the configuration entry's Notes field.
- Independently opened R2 and decrypted the selected snapshot's 161,706-byte
  PostgreSQL custom-format dump without reading VPS credential files.
- Retrieved `BETTER_AUTH_SECRET`, `CUSTOMER_PII_ENCRYPTION_KEY` and
  `CUSTOMER_PII_BLIND_INDEX_KEY` from the vault. All three matched the deployed
  staging values; the restored applications used those vault-sourced values.
- Repeated every technical application, encryption, authentication and queue check
  listed below successfully. No external notifications were sent.
- All five original staging services remained healthy, their images matched the
  rerun's source images, and the backup timer remained active. No drill containers,
  volumes or networks remained after cleanup.
- The vault was read only. Secrets travelled over SSH stdin and process
  environments; temporary local recovery values were protected with Windows DPAPI.

Credential-free report:
`/var/backups/bam-recovery-drill/bam-recovery-20260924153358/report.json`.
The rerun used release `c2d7b5190f5703a6346dc0680fb67928df243cc1`:

| Service | Image ID used in vault-sourced rerun                                      |
| ------- | ------------------------------------------------------------------------- |
| API     | `sha256:cda502f9a37ee3bfef28a97a6b64a0a5f8e9494ee44949a3eddd42d3c2013bba` |
| Worker  | `sha256:08cd937102c6ddc8f498789d9ef4ca047723993706942322146afba714d72341` |
| Web     | `sha256:2bd43dfc93fb0c970c171fd23769cc4db9b20cb66864c88949d1e9a4cf1f5d22` |

PostgreSQL and Redis images and the selected R2 snapshot were unchanged from the
first run. Application configuration used the explicit isolated overrides below;
complete production configuration recovery remains unverified.

## First run: source and isolation

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

Storage credentials, repository address, authentication secret and both distinct
PII keys have now been retrieved from KeePassXC and validated in the rerun.

1. Verify complete application/deployment configuration can be reconstructed
   independently. The rerun used deliberately limited isolated configuration;
   it did not recover the intended public origins, routing or external integrations.
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
