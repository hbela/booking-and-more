> Repository implementation: see [monitoring setup](../monitoring-setup.md) for the
> actual `booking-and-more-web` / `booking-and-more-fastify` variables, build-secret
> handling, and staging verification steps. The material below is reference guidance;
> do not add its public example crash routes or replace the existing localized layout.

Yes. For your **Next.js + Fastify + Coolify/Hetzner** setup, I would configure Sentry as **two Sentry projects inside one Sentry organization**:

```text
Sentry organization
├── my-app-web        → Next.js
└── my-app-api        → Fastify / Node.js
```

This gives you clean separation between browser/Next.js errors and API/backend errors while still allowing a single distributed trace to cross from the browser into Fastify.

As of September 21, 2026, the current stable JavaScript SDK is **10.75.0**. Sentry 11 is still an RC, so I would use the stable v10 release for production for now. ([GitHub][1])

## 1. Create the Sentry projects

Go to Sentry → **Projects → Create Project**.

Create:

```text
my-app-web
Platform: Next.js
```

and:

```text
my-app-api
Platform: Node.js / Fastify
```

Each project gets its own **DSN**.

Conceptually:

```text
WEB_SENTRY_DSN=https://xxx@....ingest.de.sentry.io/111
API_SENTRY_DSN=https://yyy@....ingest.de.sentry.io/222
```

The DSN is not the secret that needs strong protection. Your **SENTRY_AUTH_TOKEN**, used for source-map uploads/releases, is the sensitive value.

---

# 2. Configure the Next.js application

Sentry currently recommends its Next.js wizard. It installs `@sentry/nextjs`, configures the project, and enables automatic error and performance monitoring. ([npm][2])

From your **Next.js project directory**:

```bash
cd web

npx @sentry/wizard@latest -i nextjs
```

Log in to Sentry when asked and choose:

```text
Organization: your-organization
Project: my-app-web
```

The wizard normally creates/configures files similar to:

```text
web/
├── instrumentation.ts
├── instrumentation-client.ts
├── sentry.server.config.ts
├── sentry.edge.config.ts
└── next.config.ts
```

For modern Next.js, `instrumentation.ts` is important because it initializes Sentry for the Node/Edge runtime and exposes `onRequestError`. ([GitHub][3])

---

# 3. Configure the Next.js browser

I recommend something approximately like this:

```ts
// instrumentation-client.ts

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  environment:
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "production",

  tracesSampleRate: 0.1,

  replaysSessionSampleRate: 0.01,
  replaysOnErrorSampleRate: 1.0,

  sendDefaultPii: false,
});

export const onRouterTransitionStart =
  Sentry.captureRouterTransitionStart;
```

I would **not start with `tracesSampleRate: 1` in production**. That means recording every transaction.

For an ordinary SaaS application, start with:

```text
tracesSampleRate = 0.10       → 10%
normal Session Replay = 1%
Replay when an error occurs = 100%
```

You can adjust them once you see your actual Sentry volume.

Because you're operating in the EU, I would also start with:

```ts
sendDefaultPii: false
```

unless you have specifically decided what personal information you want sent to Sentry.

---

# 4. Configure Next.js server-side monitoring

Your generated `sentry.server.config.ts` can look like:

```ts
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  environment:
    process.env.SENTRY_ENVIRONMENT ?? "production",

  tracesSampleRate: 0.1,

  sendDefaultPii: false,
});
```

And `instrumentation.ts`:

```ts
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError =
  Sentry.captureRequestError;
```

This is particularly useful for errors in:

```text
Server Components
Route Handlers
Server Actions
SSR
Middleware / Edge runtime
```

---

# 5. Configure `next.config.ts`

The wizard normally modifies this automatically.

With current Sentry 10.x, the newer/future-proof import is:

```ts
import { withSentryConfig } from "@sentry/nextjs/config";
```

Sentry introduced this entry point in v10 ahead of the v11 change. ([GitHub][4])

Example:

```ts
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  // your existing config
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  silent: true,

  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
});
```

The important part is the **source maps**.

Without them, a production error might look like:

```text
at a (chunk-8c924.js:1:17185)
```

With them:

```text
at createAppointment
src/features/appointments/createAppointment.ts:73
```

Sentry's build tooling can generate releases and upload source maps automatically. ([Sentry Docs][5])

---

# 6. Add Next.js variables to Coolify

Go to:

**Coolify → your Web application → Configuration → Environment Variables**

Coolify currently allows each variable to be separately marked as a **Build Variable** and/or **Runtime Variable**. ([Coolify][6])

Add:

```env
NEXT_PUBLIC_SENTRY_DSN=https://xxx@....ingest.de.sentry.io/111

SENTRY_DSN=https://xxx@....ingest.de.sentry.io/111

SENTRY_ORG=my-sentry-org

SENTRY_PROJECT=my-app-web

SENTRY_AUTH_TOKEN=sntrys_xxxxxxxxx

SENTRY_ENVIRONMENT=production

NEXT_PUBLIC_SENTRY_ENVIRONMENT=production
```

I would configure them roughly like this:

| Variable                         |    Build | Runtime |
| -------------------------------- | -------: | ------: |
| `NEXT_PUBLIC_SENTRY_DSN`         |        ✅ |       ✅ |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` |        ✅ |       ✅ |
| `SENTRY_DSN`                     | optional |       ✅ |
| `SENTRY_ENVIRONMENT`             | optional |       ✅ |
| `SENTRY_ORG`                     |        ✅ |       ❌ |
| `SENTRY_PROJECT`                 |        ✅ |       ❌ |
| `SENTRY_AUTH_TOKEN`              |        ✅ |       ❌ |

The especially important one is:

```text
NEXT_PUBLIC_SENTRY_DSN
```

It must exist **during `next build`**, because `NEXT_PUBLIC_*` variables get baked into the browser bundle.

After changing build variables, do a **new deployment**, not merely a container restart. Coolify explicitly distinguishes those cases. ([Coolify][6])

---

# 7. Protect `SENTRY_AUTH_TOKEN`

Do **not** put this into Git:

```env
SENTRY_AUTH_TOKEN=sntrys_xxxxx
```

and definitely don't call it:

```text
NEXT_PUBLIC_SENTRY_AUTH_TOKEN
```

That would expose it to browsers.

Coolify also warns that traditional Docker build arguments can remain visible in image metadata. If you're using your own Dockerfile with BuildKit, Coolify supports **Docker Build Secrets** for sensitive build-time values. ([Coolify][6])

Your DSN can be public.

Your auth token cannot.

---

# 8. Test the Next.js installation

Create a temporary route/page or button:

```ts
import * as Sentry from "@sentry/nextjs";

export function testSentry() {
  Sentry.captureException(
    new Error("Test Next.js Sentry error")
  );
}
```

Deploy it.

Trigger the error.

Then open:

```text
Sentry
→ Projects
→ my-app-web
→ Issues
```

You should see:

```text
Test Next.js Sentry error
```

More importantly, verify that the stack trace points to your **TypeScript source**, not a minified JS chunk.

That confirms that source-map uploading is working.

---

# 9. Now configure Fastify

In your API:

```bash
cd api

npm install @sentry/node
```

The current stable package is `@sentry/node 10.75.0`. Sentry emphasizes that initialization needs to happen **before the modules being instrumented are imported**. ([npm][7])

This is important.

Don't do:

```ts
import Fastify from "fastify";
import prisma from "./prisma";
import * as Sentry from "@sentry/node";

Sentry.init(...);
```

Sentry has initialized too late.

---

# 10. Create a Fastify Sentry instrument file

For an ESM TypeScript project, create something like:

```text
src/instrument.ts
```

```ts
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  environment:
    process.env.SENTRY_ENVIRONMENT ?? "production",

  tracesSampleRate: 0.1,

  sendDefaultPii: false,
});
```

Sentry recommends initializing before Fastify and other instrumented libraries are loaded because its Node monitoring is based on automatic instrumentation/OpenTelemetry. ([npm][7])

---

# 11. Make sure `instrument.ts` runs first

Suppose your compiled application is:

```text
dist/server.js
```

Run it as:

```bash
node --import ./dist/instrument.js ./dist/server.js
```

or use:

```env
NODE_OPTIONS=--import=./dist/instrument.js
```

Sentry specifically documents `--import` for modern ESM Node applications. ([Sentry Docs][8])

For example:

```json
{
  "scripts": {
    "start": "node --import ./dist/instrument.js ./dist/server.js"
  }
}
```

Then Coolify can simply run:

```bash
npm run start
```

---

# 12. Connect the Fastify error handler

For Sentry **10.x stable**, you can still use:

```ts
import Fastify from "fastify";
import * as Sentry from "@sentry/node";

const app = Fastify();

Sentry.setupFastifyErrorHandler(app);

// plugins
// routes
// etc.

await app.listen({
  port: Number(process.env.PORT) || 3001,
  host: "0.0.0.0",
});
```

Note that this is an area that's changing in Sentry 11: the new `fastifyIntegration()` handles error capture automatically and `setupFastifyErrorHandler()` is being deprecated. That's another reason I would stay on stable **10.75.0** for the initial installation rather than jump immediately to the v11 release candidate. ([GitHub][4])

---

# 13. Add Fastify variables to Coolify

Go to:

**Coolify → API application → Configuration → Environment Variables**

Add:

```env
SENTRY_DSN=https://yyy@....ingest.de.sentry.io/222

SENTRY_ENVIRONMENT=production
```

For basic error/performance monitoring, that's enough.

These should be:

```text
Runtime Variable: YES
Build Variable: NO
```

unless you're also uploading API source maps during your API build.

---

# 14. Test Fastify

Add a temporary route:

```ts
app.get("/sentry-test", async () => {
  throw new Error("Test Fastify Sentry error");
});
```

Deploy and call:

```text
https://api.example.com/sentry-test
```

Then check:

```text
Sentry
→ Projects
→ my-app-api
→ Issues
```

You should see the error.

Then delete the test endpoint.

---

# 15. Add distributed tracing between Next.js and Fastify

This is one of the most useful parts of your architecture.

Imagine:

```text
Browser
   ↓
Next.js
   ↓
Fastify API
   ↓
PostgreSQL
```

Instead of four isolated measurements, Sentry can show something like:

```text
GET /appointments
│
├── browser fetch               38 ms
│
└── GET api.example.com/...    145 ms
     │
     ├── Fastify handler        12 ms
     │
     └── PostgreSQL query      108 ms
```

If your API is another origin, such as:

```text
https://app.example.com
https://api.example.com
```

add the API domain to the browser configuration:

```ts
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  tracesSampleRate: 0.1,

  tracePropagationTargets: [
    "localhost",
    /^https:\/\/api\.example\.com/,
  ],
});
```

By default, tracing headers are attached to same-origin requests; another subdomain/origin needs to be included explicitly. ([Sentry Docs][9])

---

# 16. Allow Sentry tracing headers through Fastify CORS

Distributed tracing uses:

```text
sentry-trace
baggage
```

If your frontend and Fastify API are different origins, these headers must be allowed by CORS. Sentry documents this explicitly. ([Sentry Docs][10])

For example, if you configure headers manually:

```ts
await app.register(cors, {
  origin: "https://app.example.com",

  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "sentry-trace",
    "baggage",
  ],
});
```

Then a frontend trace can continue into Fastify instead of appearing as two unrelated transactions.

---

# 17. Add releases

This is worth doing because instead of merely seeing:

```text
Error started 14:43
```

Sentry can tell you:

```text
First appeared in release:
2da9751
```

A Git commit hash is an excellent release identifier.

Coolify already exposes:

```text
SOURCE_COMMIT
```

for deployments. ([Coolify][6])

You can eventually map that to:

```env
SENTRY_RELEASE=<git commit SHA>
```

Using the **same commit SHA for web and API** is particularly useful if they're in the same monorepo.

Sentry uses releases to correlate issues with deployments and source maps. ([Sentry Docs][11])

---

# 18. A useful Sentry production configuration

For your first production deployment I'd use approximately:

```text
Errors
    100%

Performance traces
    10%

Normal browser replay
    1%

Replay when error occurs
    100%

PII
    OFF

Environment
    production

Source maps
    ON

Releases
    ON
```

That provides a lot of useful information without immediately generating a very large event volume.

---

# 19. Configure Sentry alerts

Once events are arriving, configure alerts.

I would start with only a few useful ones:

```text
New production issue
        ↓
notify me

Previously resolved issue regressed
        ↓
notify me

Sudden increase in server errors
        ↓
notify me

High API failure rate
        ↓
notify me
```

Don't initially configure alerts for every individual exception. It becomes noisy very quickly.

---

# 20. Fastify logging can come later

Your Fastify logger is normally Pino, and modern Sentry can integrate with structured logs as well.

Sentry 10.71 changed logs so that logging support is enabled by default, although nothing is sent simply because that option is enabled—you still have to use Sentry logging APIs or a log-forwarding integration. ([GitHub][1])

I would therefore do this in two phases:

```text
Phase 1
├── Errors
├── Performance
├── Source maps
├── Releases
├── Browser Replay
└── Distributed tracing

Phase 2
├── Fastify/Pino logs
├── Custom metrics
├── uptime monitoring
├── cron monitoring
└── custom dashboards
```

That keeps the initial installation understandable.

---

# 21. Your final architecture

When everything is working, the monitoring flow should look like:

```text
             SENTRY
               │
       ┌───────┴────────┐
       │                │
my-app-web         my-app-api
       │                │
   Next.js            Fastify
       │                │
Browser errors      API errors
Server errors       API latency
Performance         DB latency
Session replay      External calls
       │                │
       └──── trace ─────┘
```

And deployment:

```text
GitHub
   ↓
Coolify
   ↓
Docker build
   │
   ├── SENTRY_AUTH_TOKEN
   │       ↓
   │   upload source maps
   │
   ↓
Docker containers
   ├── web
   │    └── SENTRY_DSN
   │
   └── api
        └── SENTRY_DSN
             ↓
           Sentry
```

For your Hetzner/Coolify deployment, I would implement this in exactly this order: **Next.js error monitoring → source maps → Fastify error monitoring → distributed tracing → releases → alerts → logging**. That makes troubleshooting each stage much easier.

Would you like the next step to be **1) exact Next.js files, 2) exact Fastify files, or 3) the complete Coolify + Docker configuration**?

[1]: https://github.com/getsentry/sentry-javascript/releases?utm_source=chatgpt.com "Releases · getsentry/sentry-javascript · GitHub"
[2]: https://www.npmjs.com/package/%40sentry/nextjs?utm_source=chatgpt.com "@sentry/nextjs - npm"
[3]: https://github.com/getsentry/sentry-javascript/issues/17775?utm_source=chatgpt.com "Next.js 15.5.2 next-intl: Web Vitals duplicated across /:locale and normalized routes despite transaction normalization attempts · Issue #17775 · getsentry/sentry-javascript"
[4]: https://github.com/getsentry/sentry-javascript/blob/develop/MIGRATION.md?utm_source=chatgpt.com "sentry-javascript/MIGRATION.md at develop · getsentry/sentry-javascript · GitHub"
[5]: https://docs.sentry.io/platforms/javascript/guides/tanstackstart-react/sourcemaps/uploading/esbuild?utm_source=chatgpt.com "esbuild | Sentry for TanStack Start React"
[6]: https://coolify.io/docs/applications/configuration/environment-variables?utm_source=chatgpt.com "Environment Variables | Coolify Docs"
[7]: https://www.npmjs.com/package/%40sentry/node?utm_source=chatgpt.com "@sentry/node - npm"
[8]: https://docs.sentry.io/platforms/javascript/guides/fastify/install/esm__v8.x?utm_source=chatgpt.com "ESM (MJS) | Sentry for Fastify"
[9]: https://docs.sentry.io/platforms/javascript/guides/tanstackstart-react/migration/v7-to-v8/?utm_source=chatgpt.com "Migrate from 7.x to 8.x | Sentry for TanStack Start React"
[10]: https://docs.sentry.io/platforms/javascript/guides/cloudflare/tracing/trace-propagation/dealing-with-cors-issues/?utm_source=chatgpt.com "Dealing with CORS Issues | Sentry for Cloudflare"
[11]: https://docs.sentry.io/api/releases/create-a-new-release-for-an-organization/?utm_source=chatgpt.com "Create a New Release for an Organization | Sentry Docs"
