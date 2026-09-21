# Sentry and UptimeRobot monitoring

Selected on 2026-09-21. Accounts/monitor destinations are not yet connected or
verified. Keep staging and production clearly separated.

## Staging account setup

Create a Sentry Node.js project for the backend. The API and worker can share its
DSN: events have `service=api` or `service=worker` tags. Configure in Coolify:

```text
SENTRY_DSN=<project DSN>
SENTRY_ENVIRONMENT=staging
```

Keep `NODE_ENV=production` for container runtime behavior. The updated Compose
configuration sets `SENTRY_RELEASE` from `SOURCE_COMMIT`. Deploy the code containing
these settings before relying on the environment/release tags. API and worker
instrumentation already exists; browser/Next.js error capture is not configured.
Verify a controlled diagnostic reaches Sentry and contains no customer details,
authentication cookies or invitation links. Configure issue alerts and recipients
in Sentry; SDK initialization alone does not establish alert delivery.

Create these UptimeRobot monitors, assign operator alert contacts, and test delivery:

| Monitor                 | Type                 | Target / expectation                                                             |
| ----------------------- | -------------------- | -------------------------------------------------------------------------------- |
| Staging web             | HTTPS                | `https://app.booking.appointer.hu/api/health`, HTTP 200                          |
| Staging API             | HTTPS                | `https://api.booking.appointer.hu/health/ready`, HTTP 200                        |
| Staging database backup | Cron-job / heartbeat | Successful backups every 30 minutes; DOWN/alert after 50 minutes without success |

Use one-minute HTTP checks if supported by the account; otherwise document the
available interval. Ensure the heartbeat interval/grace/notification delay together
produce an alert before the newest successful backup reaches one hour old.
Create separate production monitors once the production domains exist.

Store the staging backup heartbeat URL in the root-only file
`/etc/bam/staging-backup-monitor-url` on the VPS. The prepared systemd service reads
that credential and calls it only after dump, encrypted upload and retention succeed.
Do not manually ping it to simulate a successful backup. Then follow
[staging backup and recovery](staging-backup-recovery.md) to run the service manually,
confirm receipt, enable its timer and exercise the missing-backup alert.

## Remaining coverage

- Worker heartbeat freshness is checked by Docker; external delivery of worker-down
  alerts still needs configuration. A green API monitor does not prove worker health.
- Overdue and failed background work is currently logged as aggregate counts;
  log warnings do not automatically become Sentry issues or UptimeRobot alerts.
- Disk pressure and billing/invoicing failure alert paths need explicit wiring and
  an end-to-end test before the production monitoring gate is complete.
- Test Sentry scrubbing and delivery, uptime alerts, missing-heartbeat alerts,
  and operator receipt separately; never include patient data in test events.

References: [UptimeRobot heartbeat monitoring](https://uptimerobot.com/help/heartbeat-monitoring/).
