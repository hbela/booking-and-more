# Phase 10 — Deployment to a Hetzner VPS with Coolify

**Document version:** 1.1 — written 2026-08-05, §2.6–§2.8 added 2026-08-06 from the first real deployment.
**Status:** **partly walked.** The images, the stack and the migration path are built and verified locally,
and a first deployment to a real Hetzner VPS reached healthy containers. It took three attempts, and each
failure is recorded: §2.6 the API refusing to boot over empty variables, §2.7 a base URL without its
scheme, §2.8 a healthy stack with no route to it. Nothing has yet been exercised end to end **through** the
proxy, so §6's checklist is still unrun. §9 is honest about what remains.
**Read first:** [phase-0-technical-foundation.md](phase-0-technical-foundation.md) §4, which is where the
Docker files came from and why they were written before anything could run them.

---

# 1. What this covers

One Hetzner VPS running [Coolify](https://coolify.io), serving the whole product: the Next.js app, the
Fastify API, the BullMQ worker, PostgreSQL 18 and Redis. Coolify's bundled Traefik terminates TLS and
routes two domains to two containers.

It is deliberately the smallest topology that is not a toy. Everything is on one host, which means one
machine to lose; §8.3 says what to do about that. What it buys is that the deploy is one `git push` and the
whole stack is described by one file that is reviewed like any other.

## 1.1 Why this document exists at the end of Epic 9 rather than Epic 0

The Docker files were written in Phase 0 so that "production parity is defined and reviewable rather than
improvised at deploy time". That was the right instinct and it half worked: the topology was right, the
multi-stage builds were right, the non-root users and healthchecks were right.

But nothing had ever run them. **All three images failed to build, and the database container could not
start at all.** Four separate defects, none of which a reviewer would catch by reading, and all of which
would have been discovered under time pressure on the day of the first deploy. §2.1–§2.5 record them.

Writing this document found those five. **Deploying for real found three more** — §2.6, §2.7 and §2.8 —
and they are the more interesting half, because each one lived in the gap between something verified
locally and something a platform does to it. A stack that builds, boots and passes every healthcheck on a
laptop can still serve nobody, and the only way to learn which of those gaps exist is to go through them.

---

# 2. What was broken

Every one of these was found by building and running the images, not by reading them.

## 2.1 The dependency stage went stale, silently, four times over

Each Dockerfile copied a hand-written list of `package.json` files before installing, to get a cached
dependency layer:

```dockerfile
COPY packages/config/package.json ./packages/config/
COPY packages/contracts/package.json ./packages/contracts/
# ... six more, by name
```

`packages/auth`, `packages/availability-engine`, `packages/booking-engine` and
`packages/notification-engine` were all added after that list was written, and nothing updated it.
`pnpm install --frozen-lockfile` refuses a lockfile that names workspace projects which are not on disk, so
the build failed — with an error about the lockfile, naming none of the four missing manifests.

The list is now gone. Each Dockerfile does `COPY . .` and installs from the whole workspace. That costs the
separate install layer — editing a source file now reinstalls — but the pnpm store mount (§2.2) makes the
reinstall a relink rather than a download, and **a new package can no longer break the image by existing**.

## 2.2 The pnpm store cache mount pointed at a directory pnpm never used

```dockerfile
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
```

pnpm's store defaults to `~/.local/share/pnpm/store`. Nothing told it otherwise, so the cache was mounted
at a path nothing wrote to, and every build re-fetched the entire dependency graph while looking cached.
Fixed with `ENV npm_config_store_dir=/pnpm/store` above the mount.

This one was only ever a waste of time. It is recorded because a cache that appears to work is
indistinguishable from one that does, until someone measures.

## 2.3 `.tsbuildinfo` leaked into the build and made tsc emit almost nothing ★

The worst of the four, because it produces a **broken image that builds successfully**.

`packages/tsconfig/base.json` sets `"incremental": true`, so tsc writes a `.tsbuildinfo` next to each
tsconfig recording what it has already emitted. Those files are gitignored — so CI, which checks out clean,
never sees one. A Docker build does not check out clean: it copies the working tree, and `.dockerignore`
excluded `dist` but not `*.tsbuildinfo`.

So inside the image tsc read a manifest asserting the outputs were already up to date, found `dist/` empty
because that _was_ excluded, and emitted almost nothing. **Exit code 0. No diagnostics.** The failure
surfaced two stages later as:

```
src/plugins/request-context.plugin.ts(4,32): error TS2305:
  Module '"@bam/observability"' has no exported member 'runWithRequestContext'.
```

which reads like a broken import and is nothing of the kind. `packages/observability/dist` contained
`index.d.ts` and `sentry.js`, and none of `logger`, `redaction` or `request-context` — an arbitrary subset,
determined by which files happened to postdate the last build on the developer's machine.

`.dockerignore` now excludes `*.tsbuildinfo` and `**/*.tsbuildinfo`, with the reasoning in the file.

The general shape is worth keeping: **an incremental build's state file is a claim about a directory that
is not in the image.** Any tool with a cache manifest outside its cache can do this.

## 2.4 `postgres:18` refuses to start on the volume path we gave it

```yaml
volumes:
  - postgres-data:/var/lib/postgresql/data # crash loop
```

The 18+ official images store data in a major-version-specific subdirectory, so that a later
`pg_upgrade --link` does not have to cross a mount boundary. They check for a mount at the old path and
**refuse to start** — not warn — when they find one:

```
Error: in 18+, these Docker images are configured to store database data in a
       format which is compatible with "pg_ctlcluster" …
       there appears to be PostgreSQL data in:
         /var/lib/postgresql/data (unused mount/volume)
```

The mount is now one level up, at `/var/lib/postgresql`, in both compose files. Data lands in
`/var/lib/postgresql/18/docker`, and an eventual 19 upgrade has both versions inside the one volume.

## 2.5 `prisma generate` needs a `DATABASE_URL` it will never connect to

Not a defect — a consequence of a deliberate decision, recorded so the placeholder in the Dockerfiles is not
mistaken for carelessness.

`packages/db/prisma.config.ts` throws when `DATABASE_URL` is unset, which is right: for a human at a
terminal that is nearly always the actual mistake. But `prisma generate` reads `schema.prisma` and does not
connect to anything, and at image build time there is no database to point it at. The build therefore sets a
placeholder **on that one command** rather than as an `ENV`, so it cannot reach the runtime stage and be
mistaken for configuration:

```dockerfile
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/prisma_generate_does_not_connect \
    pnpm --filter @bam/api... build
```

## 2.6 A blank variable is not an unset one — and the platform decides which you get ★

Found on the first real deployment, which is exactly the class §9.1 warned would still be out there.

The API would not boot. It reported **eleven** problems, and every one of them was a feature the operator
had deliberately not configured:

```
Invalid environment configuration (11 problems):
  - GOOGLE_CLIENT_ID: Too small: expected string to have >=1 characters
  - STRIPE_SECRET_KEY: Too small: expected string to have >=1 characters
  - TRIAL_PERIOD_DAYS: Too small: expected number to be >0
  - SENTRY_DSN: Invalid URL
  …
```

`TRIAL_PERIOD_DAYS` is the one to look at twice. The schema carries `.default(30)`. A default cannot be
"too small" — unless the key is present, because `z.coerce.number()` on `""` yields **0**, and a default
only applies to an absent key. Every one of the eleven was a variable that arrived **set and empty**.

This file's own compose comment had reasoned the problem through and reached a fix that does not survive
contact with a deployment platform. Optional keys were written as bare pass-through entries
(`- STRIPE_SECRET_KEY`, with no `=`), because plain `docker compose` omits an unset pass-through key from
the container rather than setting it to `""`. That is true, and verifiable with `docker compose config`,
and it is not what happens here: **Coolify imports every variable named anywhere in the compose file into
its own environment manager**, then writes them all into the env file it runs compose with. A key nobody
filled in comes back as `KEY=`.

So the guarantee cannot live in the compose file, because the compose file is not the last thing to touch
the environment. `@bam/config` now drops empty values before validating, which makes blank and absent the
same thing no matter where the environment came from — a `.env` line left blank, a Coolify field left
empty, a CI secret that did not resolve. Both directions are pinned by tests: a required variable that
arrives blank still fails, and a half-configured pair (`RESEND_API_KEY` set, `EMAIL_FROM` blank) is still
the boot error it was designed to be.

The general shape, and the reason this sits beside §2.3: **a rule enforced in one layer is only enforced
until something else rewrites that layer's input.** Rule 4 says a missing key degrades one feature and
never takes the process down. That is a property of the config schema, so it belongs in the config schema.

## 2.7 A base URL without its scheme fails the web build, on a page nobody was thinking about

`API_BASE_URL` was set to `apI.tanarock.hu` — no scheme, and a capital `I` that is invisible in most
terminals. The image would not build:

```
Error occurred prerendering page "/hu/sign-in"
[BetterAuthError]: Invalid base URL: apI.tanarock.hu
  code: 'ERR_INVALID_URL', input: 'apI.tanarock.hu'
```

The value reaches the web build as `NEXT_PUBLIC_API_BASE_URL`, Better Auth's client is constructed at
module scope in `apps/web/src/lib/auth-client.ts`, and Next prerenders `/[locale]/(auth)/sign-in`. So
`new URL()` runs at **build** time on a value that is only ever _used_ in a browser.

`@bam/config` would have caught it — `z.url()` rejects both `apI.tanarock.hu` and `app.tanarock.hu`. But
**`apps/web` does not use `@bam/config`**. It reads `process.env["NEXT_PUBLIC_API_BASE_URL"]` directly in
four places, each with `?? "http://localhost:3001"`. Rule 3 says the environment is parsed once at the
edge; the web app has no edge.

That fallback is the worse half, and it is still there. A malformed URL at least fails loudly. An
**absent** one does not fail at all: `${API_BASE_URL:?…}` only checks non-empty, so the build succeeds and
deploys a site whose browser calls `http://localhost:3001` — green everywhere, broken for every visitor,
with nothing naming the cause. Open, and recorded in §9.7.

## 2.8 Healthy containers, and nothing reachable ★

Every container up and healthy, Coolify's Links dropdown empty, and the browser answering
`ERR_CONNECTION_REFUSED`.

The compose file named no domain anywhere. It used `expose:` — which publishes nothing and routes nothing;
it is documentation for a human — and §5.5 of this document told the operator to type the domains into
Coolify's UI instead. That is one instruction away from a stack that builds, boots, passes every
healthcheck and serves no one.

**`SERVICE_FQDN_<SERVICE>_<PORT>` is the mechanism.** Named in a service's `environment`, Coolify generates
an FQDN, surfaces it as an editable field on the resource, and writes the Traefik labels that terminate TLS
and forward to that container port. Absent, there is no router at all. `api` and `web` now declare
`SERVICE_FQDN_API_3001` and `SERVICE_FQDN_WEB_3000`; `worker` deliberately declares none, because it
answers nothing and must not be routable.

Read the symptom carefully, because the two failures are different and look similar:

| Symptom                  | Meaning                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `ERR_CONNECTION_REFUSED` | Nothing is listening on 443 — proxy down, or the port is firewalled     |
| `404` from Traefik       | Proxy is up and has no route for that hostname — an FQDN/domain problem |

A refused connection is therefore **not** by itself proof of the missing-FQDN bug: check that Coolify's
proxy is running (Servers → Proxy) and that the firewall admits 80 and 443, before concluding anything
about routing. Both had to be right here, and only one of them was in this document.

This is also why the environment anchor is a mapping rather than a list: `api` needs one variable the
others must not have, and YAML merges mappings but cannot concatenate sequences. §2.6's fix is what made
that safe, since mapping form cannot express "absent" and no longer has to.

---

# 3. The topology

```
                    Internet
                       │
                 ┌─────┴─────┐   Coolify's Traefik, TLS from Let's Encrypt
                 │   proxy   │
                 └──┬─────┬──┘
        app.example.com   api.example.com
                 │        │
            ┌────▼───┐ ┌──▼─────┐   ┌────────┐
            │  web   │ │  api   │   │ worker │   no domain, answers nothing
            │  :3000 │ │  :3001 │   │        │
            └────────┘ └───┬────┘   └───┬────┘
                           │            │
                   ┌───────▼────────────▼───────┐
                   │  postgres:18    redis:8     │   internal only, no host ports
                   └─────────────────────────────┘

            migrate  ─ runs once per deploy, exits 0, gates api and worker
```

Four things about it are load-bearing.

**Nothing publishes a host port.** `expose:` only. A `ports:` entry in a Coolify stack binds to the VPS's
public IP _outside_ the proxy — unrouted, un-TLS'd and unauthenticated. The database is reachable only from
this stack's network; for a `psql` prompt, open a terminal on the container from Coolify's UI.

**The browser talks to the API, not the web container.** `apps/web/src/lib/api-client.ts` is a
`"use client"` module, so every API call is made from the user's browser. The web container never needs to
reach `api.example.com`, which is why `web` does not `depends_on: api` and can keep serving pages while the
API restarts.

**The migration runs in an image built from the same commit as the code.** `migrate` is built from
`docker/Dockerfile.api` rather than being an image of its own, so the schema change applied is the one
committed beside the code that expects it. It runs `prisma migrate deploy`, which only applies migration
files that are already committed — it cannot invent one, which is what keeps this consistent with rule 1.

**A failed migration stops the deploy.** `api` and `worker` declare
`depends_on: migrate: condition: service_completed_successfully`, so a migration that exits non-zero means
they never start, rather than an API booting against a schema it does not match.

## 3.1 Two compose files, and which is which

| File                                                          | For                       | Publishes host ports       |
| ------------------------------------------------------------- | ------------------------- | -------------------------- |
| [`docker-compose.coolify.yml`](../docker-compose.coolify.yml) | Coolify. **This deploy.** | No — the proxy routes      |
| [`docker/docker-compose.yml`](../docker/docker-compose.yml)   | Local parity checks       | Yes, 3000/3001, for `curl` |

The Coolify file carries one key that is not Compose syntax: `exclude_from_hc: true` on the `migrate`
service. It is a Coolify extension, and without it Coolify reports the whole stack unhealthy after every
successful deploy, because the migration container has correctly stopped. `docker compose config` rejects
the file locally for that one key, and your editor will flag it. That is expected.

---

# 4. Before you start

## 4.1 The server

A Hetzner Cloud **CX32** (4 vCPU / 8 GB / 80 GB) or better. Coolify's own minimum is 2 GB, which is about
the instance and not about what you build on it: `pnpm install` across this workspace plus `next build` will
exhaust 4 GB. If you are on a 4 GB instance, add swap before the first deploy or the build will be killed
with no useful message:

```bash
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Ubuntu 24.04 LTS. Take Hetzner's backups — they are 20% of the instance price and they are not the same
thing as the database dumps in §8.3.

## 4.2 DNS

Two A records at your registrar, both pointing at the VPS's IPv4 address:

| Record            | Points to    | Becomes        |
| ----------------- | ------------ | -------------- |
| `app.example.com` | the VPS's IP | `APP_BASE_URL` |
| `api.example.com` | the VPS's IP | `API_BASE_URL` |

**They must be subdomains of the same registrable domain.** This is not cosmetic and it is not about
tidiness. `packages/auth/src/auth.ts` issues session cookies with `SameSite=None; Secure` whenever
`API_BASE_URL` is HTTPS. Under one registrable domain those are same-site cookies and browsers keep them.
Split the API onto an unrelated domain — a Coolify-generated `sslip.io` host, say, while the app is on your
own — and they become genuinely third-party, at which point Chrome's third-party cookie restrictions can
drop them and **every staff sign-in silently fails to stick**.

Do not create a third record for Coolify's own dashboard until §5.2 is done.

## 4.3 Accounts

Stripe (live keys, and read the memory note: the Stripe MCP is live mode — verify `livemode` before any
write), Resend with a verified sending domain, and optionally Sentry.

None of the three is required to boot. Each is a documented degradation (CLAUDE.md rule 4): no Stripe key
means the subscription screen says billing is unavailable; no Resend key means notifications are recorded
and marked undeliverable. **You will want all of them anyway**, because an owner who cannot be emailed an
invitation cannot onboard at all.

---

# 5. Deploying

## 5.1 Install Coolify

```bash
ssh root@<vps-ip>
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
```

It prints a URL like `http://<vps-ip>:8000`. Open it and create the admin account **immediately** — until
you do, anyone who finds the IP can.

## 5.2 Lock down the dashboard

In Coolify, set an FQDN for the Coolify instance itself (Settings → Instance) so it is served over TLS, then
close port 8000 at the firewall. Hetzner Cloud Firewall: allow 22, 80 and 443 inbound, nothing else.

## 5.3 Create the resource

New Resource → **Docker Compose** → your Git repository.

| Setting                 | Value                         |
| ----------------------- | ----------------------------- |
| Base Directory          | `/`                           |
| Docker Compose Location | `/docker-compose.coolify.yml` |
| Branch                  | `main`                        |

Coolify parses the file and lists six services. `migrate` will show as a one-off; that is what
`exclude_from_hc` is for.

## 5.4 Environment variables

Coolify's environment editor, on the resource. **Required — the stack will not start without them**, and
Compose names the missing one rather than failing obscurely:

| Variable             | Value                                             |
| -------------------- | ------------------------------------------------- |
| `APP_BASE_URL`       | `https://app.example.com`                         |
| `API_BASE_URL`       | `https://api.example.com`                         |
| `POSTGRES_PASSWORD`  | `openssl rand -base64 24`                         |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` — see the warning below |

Strongly wanted, all optional to the schema:

| Variable                    | Note                                                      |
| --------------------------- | --------------------------------------------------------- |
| `RESEND_API_KEY`            | With `EMAIL_FROM`, or neither                             |
| `EMAIL_FROM`                | `Booking and More <booking@example.com>`, domain verified |
| `STRIPE_SECRET_KEY`         | Requires all three Stripe entries below                   |
| `STRIPE_WEBHOOK_SECRET`     | From §5.7; a key without it sells and then cannot confirm |
| `STRIPE_PRICE_STARTER`      | `price_…`                                                 |
| `STRIPE_PRICE_PROFESSIONAL` | `price_…`                                                 |
| `SENTRY_DSN`                | Optional, alone                                           |
| `LOG_LEVEL`                 | Defaults to `info`                                        |

### Three traps in this table

**Both base URLs need their scheme.** `https://api.example.com`, never `api.example.com`. This is what
broke the first deployment: a bare hostname in `API_BASE_URL` reaches the web build as
`NEXT_PUBLIC_API_BASE_URL`, Better Auth's client is constructed at module scope, and Next prerenders
`/[locale]/(auth)/sign-in` — so `new URL("api.example.com")` throws during the build, and the whole image
fails on a page nobody was thinking about. `APP_BASE_URL` fails later and more quietly: it is the sole CORS
origin and the sole trusted origin for auth cookies, so a bad one leaves an app that builds, deploys and
serves pages while every browser request is refused. Check both for a typo before deploying — and note
that `apI` and `api` look identical at a glance in most terminals.

**Leaving a variable blank is fine.** It used to be the opposite, and the note here used to say so. Blank
now means "not configured", identically to deleting the row, because `@bam/config` strips empty values
before validating (§2.6). That is what makes it safe to leave Coolify's auto-imported fields empty — which
matters, because Coolify creates a field for every variable named in the compose file whether you wanted
one or not.

**`BETTER_AUTH_SECRET` is write-once.** Rotating it invalidates every live session at once — every signed-in
owner, provider and admin is logged out. Generate it, put it somewhere you will still have in a year, and do
not regenerate it as part of debugging something else.

## 5.5 Domains

The compose file declares two magic variables, and they are what create the routes (§2.8):

| Service | Variable                | Becomes           |
| ------- | ----------------------- | ----------------- |
| `web`   | `SERVICE_FQDN_WEB_3000` | `app.example.com` |
| `api`   | `SERVICE_FQDN_API_3001` | `api.example.com` |

Coolify generates a value for each on first deploy — something like `web-<uuid>.your-wildcard-domain` — and
shows both as editable fields. **Edit them to your own hostnames.** `worker`, `postgres`, `redis` and
`migrate` get none: the worker answers nothing, and the datastores must not be reachable from outside.

Enter the FQDN as a **hostname**, no scheme — that is what the variable is for. The `*_BASE_URL` pair are
full origins and **do** need `https://`.

**Each domain and its `*_BASE_URL` have to agree exactly** — scheme included, no trailing slash. This is the
failure mode most likely to cost you an afternoon, because the symptoms do not point at it: the API's CORS
allow-list is literally `[env.APP_BASE_URL]` (`apps/api/src/app.ts`), so a mismatch makes every browser
request fail on preflight while `curl` against the same API is perfectly healthy.

If the Links dropdown is empty after a deploy, no FQDN resolved — go back to §2.8 rather than looking at the
application, which will be running perfectly and answering no one.

## 5.6 Deploy

Press Deploy. The first one builds three images from scratch and will take several minutes.

Expected order in the log: `postgres` healthy → `redis` healthy → `migrate` runs and exits 0 → `api` and
`worker` start → all healthy. `web` starts independently of the rest.

## 5.7 Point Stripe at the API

Stripe Dashboard → Developers → Webhooks → Add endpoint:

- URL `https://api.example.com/v1/webhooks/stripe`
- Events — the thirteen `apps/worker/src/stripe/stripe.processor.ts` actually handles, no more and no fewer:
  `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`,
  `customer.subscription.trial_will_end`, `invoice.paid`, `invoice.payment_failed`,
  `subscription_schedule.created`, `subscription_schedule.updated`, `subscription_schedule.canceled`,
  `subscription_schedule.released`

Copy the signing secret into `STRIPE_WEBHOOK_SECRET` and redeploy. Until this is done, a customer can pay
and stay gated — the webhook is what activates the organization, and the API records events for the worker
to process (phase-9 §2.9).

## 5.8 Make yourself a platform admin

There is no seed and no first-run wizard; an organization comes from the same place a real one does. Sign
up through the web app as you would any user, then, from a terminal on the **api** container in Coolify:

```bash
cd /app/packages/db && ./node_modules/.bin/tsx ./scripts/grant-platform-admin.ts you@example.com
```

Then open `https://app.example.com/admin/platform` and provision the first organization. From here on,
[phase-9-manual-test-checklist.md](phase-9-manual-test-checklist.md) is the document to follow — it walks
provisioning through to cancellation, and everything in it applies unchanged to a deployed instance.

Remember rule 9: **a platform admin holds no memberships.** Use a second account for tenant-side work. The
policy layer enforces this in both directions, so you will not be able to do it by accident — only be
blocked by it at an annoying moment.

---

# 6. Verifying the deploy

Run these before you believe it.

| #   | Check                                                           | Expect                                                   |
| --- | --------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | `curl https://api.example.com/health/live`                      | `{"status":"ok",…}`                                      |
| 2   | `curl https://api.example.com/health/ready`                     | `postgres` **and** `redis` both `ok`                     |
| 3   | `curl -I https://app.example.com`                               | 200, and a valid certificate                             |
| 4   | `curl https://api.example.com/docs`                             | **404** — the OpenAPI UI is off in production, by design |
| 5   | Coolify → `migrate` logs                                        | "All migrations have been successfully applied."         |
| 6   | Coolify → `worker` logs                                         | `redis: connected`, then `queues registered`             |
| 7   | Sign in through the web app, reload the page                    | Still signed in — this is the §4.2 cookie check          |
| 8   | Provision an organization, confirm the invitation email arrives | Email path works end to end                              |

Check 7 is the one people skip. It is the only check that proves the cross-domain cookie configuration is
right, and the failure it catches — signing in, then being anonymous again on the next page — looks like a
bug in the app rather than a bug in DNS.

Check 6 deserves one note: if the worker logs
`email: RESEND_API_KEY/EMAIL_FROM not configured`, email is off. Adding the keys is not enough on its own —
**the worker memoises its email provider at boot**, so a key added afterwards does nothing until it
restarts. That is [phase-9-owner-onboarding-emails.md](phase-9-owner-onboarding-emails.md) §1, and it cost a
day the first time.

---

# 7. Deploying again

Push to `main`. Coolify rebuilds and restarts; `migrate` runs first and gates the rest.

**A schema change needs no extra step, and must not be given one.** Commit the migration with the code
(`pnpm db:migrate` locally), push, and `migrate` applies it. Never `prisma db push` against the server, and
never apply SQL by hand from a container terminal — that is CLAUDE.md rule 1, and the drift it prevents is
invisible to `prisma migrate status`.

**A change to `API_BASE_URL` needs a rebuild, not a restart.** It reaches the browser as
`NEXT_PUBLIC_API_BASE_URL`, which Next.js inlines into the client bundle at build time. Restarting `web`
with a new value changes nothing; the bundle still holds the old host. Redeploy.

---

# 8. Operating it

## 8.1 Logs

Per-service in Coolify. Everything is structured JSON through Pino, with redaction configured in
`@bam/observability` — add paths there rather than scrubbing at call sites (rule 6).

## 8.2 A database prompt

Terminal on the `postgres` container:

```bash
psql -U postgres booking_and_more
```

## 8.3 Backups ★

**Nothing here backs up your database, and Hetzner's snapshots are not a substitute** — a snapshot of a
running PostgreSQL is a crash-consistent copy, which is recoverable but is not a dump.

Set up a scheduled backup on the `postgres` resource in Coolify, to S3-compatible storage off this machine,
and **restore one before you have customers**. A backup nobody has restored is a hypothesis.

This is the single largest gap in a one-VPS topology: one machine, and everything on it.

## 8.4 Rolling back

Coolify keeps previous deployments and can redeploy one. **Code rolls back; the schema does not.** A
migration that has been applied stays applied, so rolling code back past a migration puts the old code in
front of a newer schema. Prisma's additive migrations usually survive that; a migration that drops or
renames a column will not. Before deploying anything with a destructive migration, know which commit you
would roll back to and whether it can read the schema it would find.

---

# 9. What is not done

**9.1 Nothing has been verified through the proxy.** The first deployment got as far as every container
running and healthy on a real VPS, which settles the build, the migration gate, the healthchecks and
`exclude_from_hc`. It settles nothing beyond that: **no request has ever reached this application over its
own domain.** Traefik's certificate issuance, the cross-subdomain session cookie of §4.2, and every one of
§6's eight checks are unrun. The one that matters most is check 7 — sign in, reload, still signed in —
because it is the only thing that proves the `SameSite=None` cookie configuration works between two real
hosts, and its failure mode looks like an application bug rather than a DNS one.

The previous version of this note listed "domain assignment" as unverified. It was, and it was also
wrong — §5.5 told the operator to set domains in a UI field instead of declaring `SERVICE_FQDN_*`, which is
§2.8. A gap named as unverified is not the same as a gap left safe.

**9.2 No backup is configured.** §8.3 is instructions, not a thing that has been done.

**9.3 The images ship dev dependencies.** The runtime stages copy `node_modules` whole, which is what makes
`prisma migrate deploy` and the platform-admin script runnable from the API image — deliberate, and worth
the size for now. A `pnpm prune --prod` in the runtime stage would need a different answer for both.

**9.4 Redis has no password.** It is reachable only from the stack's internal network and is not exposed. If
this VPS ever runs a second, untrusted stack, that stops being sufficient.

**9.5 `NEXT_PUBLIC_SENTRY_DSN` is in `.env.example` and is read by nothing.** The web app has no Sentry
wiring; only the API and worker do. Harmless, and confusing at exactly the wrong moment.

**9.6 Rate limiting is per-instance.** `@fastify/rate-limit` uses an in-process store
(`apps/api/src/app.ts`). With one API container that is the same thing as a global limit; it stops being
true the moment there are two.

**9.7 `apps/web` still reads its environment unvalidated, with a localhost fallback.** Four call sites do
`process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "http://localhost:3001"`, bypassing `@bam/config` entirely
(§2.7). A malformed value fails the build with an error that names Better Auth rather than the variable; an
absent one does not fail at all, and ships a site whose browser calls localhost. The fix is one module that
parses it with a clear message and no production fallback, with the four sites importing that. Not done.
