# Clean-host staging recovery — 2026-09-25

**Status: independent image rebuilding, clean-host recovery and HTTPS/browser
validation passed. Drill containers, volumes and networks were removed.**

## Host and independent sources

- New dedicated Hetzner CAX21 `bam-recovery-drill`, IPv4 `2.29.42.50`.
- Ubuntu 24.04.4, ARM64, 8 GB RAM, 80 GB disk; cloud-init completed before work.
- Initial inspection found no Docker installation. Docker Engine 29.8.1 and
  Restic 0.16.4 were installed. No images or volumes were copied from staging.
- Source revision: `c2d7b5190f5703a6346dc0680fb67928df243cc1`, exported from the
  operator's independent local Git checkout. The archive contains committed files
  only; its only environment-file match was `.env.example`.
- Source archive SHA-256:
  `21e515a372d8583eba28e567090eff739e8c1a34a95e0e2e3868a3abca9a3dd2`.
- API, worker and web were built on this new host; base images came from the
  registry. The web build used
  `NEXT_PUBLIC_API_BASE_URL=https://recovery-api.booking.appointer.hu`.
- Restic/R2 credentials, repository address, authentication secret and both PII
  keys came from the operator's KeePassXC vault over SSH stdin. No staging-host
  credential files or container environments were used. The temporary local
  DPAPI-protected credential copy was removed after the restore.

| Image  | Rebuilt image ID                                                          |
| ------ | ------------------------------------------------------------------------- |
| API    | `sha256:94ad10e6bca726ac5f66be25cb0377c5bbb1db970484d6a86f8aba09364169ce` |
| Worker | `sha256:2d4452c6c60bad0c99c8cac44d516a5ad2820d39358f689cf8f9a1e9f3821c40` |
| Web    | `sha256:5a29ff65f55c586a55b48d79b3b8f36c55f0c984e8148132172c455cad41c53d` |

PostgreSQL was pulled by digest
`postgres@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2`;
Redis by digest
`redis@sha256:becdda6c7f4b3fb42e42fd7f120bbf5c54c4caaaf16f26da24e4563d2c1f0576`.

## Timing and results

All timestamps below are UTC (Budapest is two hours ahead).

| Event                                  | Time         |
| -------------------------------------- | ------------ |
| Host software provisioning started     | 12:49:12     |
| Image builds started                   | 12:51:28     |
| Images and registry pulls ready        | 12:54:59     |
| Restore/application validation started | 12:56:00.934 |
| Restore/application validation passed  | 12:57:37.638 |

The technical checks took **96.70 seconds**. From software provisioning start to
application validation was approximately **8 minutes 26 seconds**. This excludes
the earlier manual VPS creation and SSH setup. HTTPS/browser checks subsequently
passed at 14:59:12.849 UTC, and cleanup completed at 15:00:08 UTC.
Provisioning through browser validation took **2 hours 10 minutes 0.849 seconds**,
including the DNS wait. This measured portion is under four hours, but excludes
manual VPS creation and SSH setup and does not establish the complete production gate.

Restored snapshot:
`5185871c39c19764b5d50dc09d4d10af138098c4d05b3003fd11d0dbbca62bef`,
timestamp `2026-09-24T14:30:03.198241611Z`, tag `bam-staging`. This deliberately
reuses the previously validated snapshot. Its age does not demonstrate a one-hour
recovery-point objective on September 25.

Passed checks:

- Restore into empty PostgreSQL and Redis volumes: one user, zero tenants,
  customers and bookings, and 42 migration records; no unfinished migration.
- Rebuilt API readiness and web Hungarian/English sign-in page rendering.
- Synthetic encrypted customer/booking dump-and-restore, decryption and tenant
  blind-index matching; wrong and missing keys rejected.
- Restored booking read through the API; synthetic signup, sign-in and session read.
- Pending notification reconstructed from PostgreSQL with empty Redis, then
  reconstructed again after clearing only the drill Redis and restarting its worker.
- Application external TCP egress blocked; no notifications sent.

The original R2 snapshot has no customer/booking data. Synthetic encrypted records
were created only in the restored copy and passed a second local dump/restore.
This does not prove recovery of historical customer ciphertext or production-scale
restore performance. Public launch mode is a drill-only override permitting email
credentials to remain disabled; invite-only/email acceptance remains separate.

## HTTPS/browser result and cleanup

The operator added explicit A records pointing to `2.29.42.50`:

- `recovery-app.booking.appointer.hu`
- `recovery-api.booking.appointer.hu`

The operator also added `*.booking.appointer.hu → 116.203.205.166` to preserve
staging wildcard resolution. Both recovery A records were verified, and staging's
`app.booking.appointer.hu` and `api.booking.appointer.hu` still resolved to
`116.203.205.166` before enabling HTTPS.

The reverse proxy restricted application access to the operator and recovery-host
IPs; only the proxy joined both public and internal networks. Chromium passed all
ten checks at 14:59:03.676–14:59:12.849 UTC without ignoring certificate errors:
web and API HTTPS readiness, UI signup against the rebuilt API origin, password
sign-in, secure HttpOnly session cookies, cross-origin session retrieval,
authenticated application API, restored encrypted booking read, session persistence
after reload and no requests to staging or external integrations. Web TLS was
TLS 1.3 with certificate issuer `YE2`.

The stack `bam-recovery-20260925125600` used an internal Docker network without
published application/database/Redis ports. The worker was stopped after queue
validation during the DNS wait. At 15:00:08 UTC all containers, volumes and networks
with this exact drill label were removed, and their absence verified. The existing
staging services and DNS records were not modified by the agent.

Credential-free report on the recovery host:
`/var/backups/bam-recovery-drill/bam-recovery-20260925125600/report.json`.
Build logs and provisioning timestamps:
`/opt/bam-recovery/evidence/`.

The final report and browser report were copied to the operator's local ignored
`docs/tmp/` directory. VPS deletion and removing the two explicit recovery A records
remain final teardown steps; the server continues to incur charges. Keep the
staging wildcard records. The recovered database and TLS volumes have been removed;
the server retains source, built images and credential-free evidence.
