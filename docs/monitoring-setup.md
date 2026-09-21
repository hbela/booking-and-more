# Sentry and UptimeRobot monitoring

Selected on 2026-09-21. Accounts/monitor destinations are not yet connected or
verified. Keep staging and production clearly separated.

## Staging account setup

Use `booking-and-more-web` for browser and Next.js server errors, and
`booking-and-more-fastify` for API and worker errors. Backend events have
`service=api` or `service=worker` tags. Configure in Coolify:

```text
SENTRY_DSN=<booking-and-more-fastify DSN>
WEB_SENTRY_DSN=<booking-and-more-web DSN>
SENTRY_ENVIRONMENT=staging
SENTRY_ORG=<your Sentry organization slug>
```

Keep `NODE_ENV=production` for container runtime behavior. The updated Compose
configuration sets `SENTRY_RELEASE` from `SOURCE_COMMIT`. Deploy the code containing
these settings before relying on the environment/release tags. Enable Coolify's
**Include Source Commit in Build** option so browser and backend releases match.
The web DSN/environment/release are embedded at build time; redeploy with a rebuild
after changing them. The web server receives the web DSN as its own `SENTRY_DSN`;
it does not use the backend project's DSN.

Browser, Next.js server, API and worker instrumentation is configured in code.
Tracing is sampled at 10% in production runtime. Browser replay masks text,
inputs and media, sampling 1% of sessions and sessions with captured errors.
Review replay suitability before enabling the DSN for real customers. The
same-origin `/api/monitoring` tunnel avoids opening the CSP to external ingestion
domains. Cookies, request payloads, email addresses and known link tokens are
scrubbed; avoid including customer content in exception messages in the first place.

### Source maps

Error reporting works without an auth token. Readable browser/Next.js production
stacks additionally need source-map uploads to `booking-and-more-web`.
`docker/Dockerfile.web` accepts the optional BuildKit secret `SENTRY_AUTH_TOKEN`.
Use `docker-compose.sentry.yml` as a build overlay only when a token is available
in the build process environment. Confirm your Coolify build command includes
this overlay or explicitly passes the BuildKit secret; a normal runtime variable
does not mount a build secret. Do not set the token as a Docker build argument or
any `NEXT_PUBLIC_*` variable. The default Compose deployment remains valid without
the token, with uploads disabled.

For a local build, load the wizard's ignored token into the process environment
without printing it, set `SENTRY_ORG` and `SENTRY_PROJECT=booking-and-more-web`,
then run `pnpm --filter @bam/web... build`. Uploads must run on a real build rather
than a restored Turbo cache entry. Backend builds currently emit source maps but
do not upload them; backend source-map upload remains a separate deployment step.

### Delivery verification after deploying

1. Confirm both project DSNs are configured and rebuild staging.
2. In staging only, throw a uniquely named synthetic error from the browser
   console (no customer details). Check the web project for that error with
   `environment=staging` and the deployed release.
3. From the API container's `/app` directory, run a controlled backend diagnostic:

   ```sh
   node --import ./apps/api/dist/instrument.js --input-type=module -e 'const s = await import("./packages/observability/dist/index.js"); s.captureException(new Error("Sentry staging API diagnostic")); await s.flushSentry(5000);'
   ```

   Repeat with `./apps/worker/dist/instrument.js` in the worker container; confirm
   `service=api` and `service=worker` in the backend project. These commands do not
   prove HTTP tracing; also inspect a normal API request trace from the browser.

4. Inspect event payloads for redaction and source-map resolution. Test a Next.js
   server error in an isolated staging rehearsal, without adding a public crash route.
5. Configure issue alerts in both projects and verify operator receipt. Record
   event IDs and the tested release. Until then, delivery and alerts are unverified.

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
