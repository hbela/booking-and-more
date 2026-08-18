import Fastify, {
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from "fastify";

import compress from "@fastify/compress";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { Redis } from "ioredis";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { type Env } from "@bam/config";
// PARKED — Epic 6 part 1 (see the block near "Calendar integrations" below).
// import { hasGoogleCalendar } from "@bam/config";
// import { parseEncryptionKey } from "@bam/crypto";
// import { createGoogleCalendarClient } from "@bam/google-calendar";
import { type GoogleCalendarClient, type GoogleOAuthClient } from "@bam/google-calendar";
import { createLogger, type Logger } from "@bam/observability";

import requestContextPlugin from "./plugins/request-context.plugin.js";
import errorHandlerPlugin from "./plugins/error-handler.plugin.js";
import databasePlugin from "./plugins/database.plugin.js";
import openApiPlugin from "./plugins/openapi.plugin.js";
import authPlugin from "./plugins/auth.plugin.js";
import tenantContextPlugin, { TENANT_HEADER } from "./plugins/tenant-context.plugin.js";
import authorizationPlugin from "./plugins/authorization.plugin.js";
import auditPlugin from "./plugins/audit.plugin.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { platformRoutes } from "./modules/platform/platform.routes.js";
import { billingRoutes } from "./modules/billing/billing.routes.js";
import { stripeWebhookRoutes } from "./modules/billing/webhook.routes.js";
import {
  createStripePaymentLinkClient,
  createStripePortalSession,
  type PaymentLinkClient,
} from "./modules/billing/stripe.client.js";
import { tenantRoutes } from "./modules/tenants/tenant.routes.js";
import {
  invitationAcceptRoutes,
  membershipRoutes,
} from "./modules/memberships/membership.routes.js";
import { meRoutes } from "./modules/me/me.routes.js";
import { providerRoutes } from "./modules/providers/provider.routes.js";
import { serviceRoutes } from "./modules/services/service.routes.js";
import { locationRoutes } from "./modules/locations/location.routes.js";
import { availabilityRoutes } from "./modules/availability/availability.routes.js";
import {
  myDelegationRoutes,
  providerDelegationRoutes,
} from "./modules/delegations/delegation.routes.js";
import { bookingRoutes } from "./modules/bookings/booking.routes.js";
import { publicCatalogueRoutes } from "./modules/public/catalogue.routes.js";
import { publicBookingRoutes } from "./modules/public/booking.routes.js";
import { trustImmediatePrivateProxy } from "./lib/trusted-proxy.js";
// PARKED — Epic 6 part 1.
// import { integrationRoutes } from "./modules/integrations/integration.routes.js";
// import { getGoogleOAuth } from "./modules/integrations/google.client.js";

export const API_VERSION = "0.1.0";

/**
 * The app as actually constructed: the Zod type provider is attached (so route
 * handlers infer body/query/params from the schema) and the logger is the pino
 * instance passed as `loggerInstance`, not Fastify's default.
 */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger,
  ZodTypeProvider
>;

export interface BuildAppOptions {
  env: Env;
  /** Silence logs in tests. */
  logger?: boolean;
  /**
   * Register the rate limiter. Defaults to true.
   *
   * Turned off by the integration suite, which legitimately makes hundreds of
   * sign-ups and tenant creations in a few seconds. Expressed as an explicit
   * option rather than an `if (NODE_ENV === "test")` inside the app, so the
   * limiter is still exercised by the test that specifically asserts it.
   */
  rateLimit?: boolean;
  /**
   * Test seam: the Stripe payment-link client, overriding the one built from
   * `STRIPE_SECRET_KEY`.
   *
   * Selling a subscription now makes a real Stripe API call
   * (docs/phase-9-duplicate-subscription-prevention.md §4.1), where it used to
   * be pure URL construction from config. Without a seam the suite would either
   * hit the network or be unable to exercise subscribing at all — and
   * subscribing is what the most important test in `billing.test.ts` is about.
   *
   * Expressed here rather than as an `if (NODE_ENV === "test")` inside the
   * composition root, for the same reason `rateLimit` is.
   */
  paymentLinkClient?: PaymentLinkClient;
  /**
   * Test seam: Google's OAuth endpoints, overriding the ones built from
   * `GOOGLE_CLIENT_ID` and friends.
   *
   * **Inert while Epic 6 part 1 is parked** — the routes that read it are not
   * registered. Kept so un-parking is one block, not an API change.
   *
   * **It replaces the network layer and does not enable the feature.** Whether
   * calendar sync is on is decided by `hasGoogleCalendar(env)` alone, so a suite
   * that wants working routes sets the four variables to fake values and injects
   * this to keep `fetch` out of it — and a suite that wants to assert the 503
   * simply omits them, which is also what CI does for every other suite in the
   * repo (docs/phase-6-google-calendar-part-1.md §7.2).
   */
  googleOAuthClient?: GoogleOAuthClient;
  /** Test seam: the Calendar API. Same rules as `googleOAuthClient` above. */
  googleCalendarClient?: GoogleCalendarClient;
}

/**
 * Composition root.
 *
 * Exported separately from `server.ts` so tests can build a fully wired app and
 * drive it with `fastify.inject()` — no listening socket, no port conflicts, no
 * hand-pasted auth tokens. The predecessor project's "tests" were supertest
 * scripts against a hard-coded localhost:3000 that silently passed when a token
 * was unset; this is the fix for that.
 */
export async function buildApp(options: BuildAppOptions): Promise<AppInstance> {
  const { env } = options;
  const isProduction = env.NODE_ENV === "production";

  const app = Fastify({
    loggerInstance:
      options.logger === false
        ? createLogger({ service: "api", level: "silent" })
        : createLogger({
            service: "api",
            level: env.LOG_LEVEL,
            pretty: !isProduction,
          }),

    // We generate our own IDs in the request-context plugin, so Fastify's
    // built-in header handling is switched off.
    requestIdHeader: false,

    // tech-impl §34.1 — bound the request body. Voice uploads get their own,
    // larger limit on their specific route in Epic 8.
    bodyLimit: 1_048_576, // 1 MiB
    trustProxy: trustImmediatePrivateProxy,
  }).withTypeProvider<ZodTypeProvider>();

  // Zod drives both validation and response serialization. Registering these is
  // half the job; the other half is every route actually declaring a `schema`
  // (CLAUDE.md rule 2).
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // --- Infrastructure -------------------------------------------------------
  await app.register(requestContextPlugin);
  await app.register(errorHandlerPlugin);

  await app.register(helmet, {
    // The API serves JSON, not documents; CSP belongs on the web app. Disabled
    // here so it does not break the OpenAPI reference page.
    contentSecurityPolicy: false,
  });

  // Responses only. `requestEncodings` is deliberately left alone: the Stripe
  // webhook reads a raw body to verify its signature, and decompressing
  // requests here would put a transform between the bytes Stripe signed and
  // the bytes we check.
  //
  // It earns its place on one endpoint in particular. The public slot search
  // answers a month with a few thousand objects that are almost entirely
  // near-identical ISO timestamps — ~430 KB that gzip takes to ~15 KB — and
  // nothing else in the stack can compress it: the browser calls the API
  // cross-origin, so the web app's server is not in the path, and Coolify's
  // Traefik does not enable compression by default.
  await app.register(compress, { global: true, threshold: 1024 });

  // Explicit allow-list. Not `origin: true` — the predecessor shipped
  // reflect-any CORS alongside `credentials: true`, which defeats the point.
  //
  // The tenant header is named from TENANT_HEADER rather than spelled out
  // again: a request the plugin reads but CORS does not allow fails only in a
  // browser, and only on preflight, so `fastify.inject()` cannot catch the
  // mismatch. It went unnoticed through all of Epic 1 for exactly that reason.
  await app.register(cors, {
    origin: [env.APP_BASE_URL],
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Request-Id",
      TENANT_HEADER,
    ],
    exposedHeaders: ["X-Request-Id"],
  });

  // Redis makes the budget shared across replicas and restarts in production.
  // Local development may omit REDIS_URL and deliberately falls back to the
  // plugin's in-process store so one optional dependency cannot prevent boot.
  let rateLimitRedis: Redis | undefined;
  if (options.rateLimit !== false) {
    rateLimitRedis = env.REDIS_URL
      ? new Redis(env.REDIS_URL, {
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          lazyConnect: false,
          retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
        })
      : undefined;

    rateLimitRedis?.on("error", (error: Error) => {
      // The URL carries credentials and is intentionally never logged.
      app.log.error({ err: error }, "rate-limit: Redis connection error");
    });

    if (rateLimitRedis) {
      const redis = rateLimitRedis;
      app.addHook("onClose", async () => {
        if (redis.status === "end") return;
        try {
          await redis.quit();
        } catch {
          redis.disconnect();
        }
      });
    }

    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: "1 minute",
      nameSpace: "bam:api:rate-limit:",
      ...(rateLimitRedis ? { redis: rateLimitRedis } : {}),
    });
  }

  await app.register(databasePlugin, {
    databaseUrl: env.DATABASE_URL,
    logQueries: env.NODE_ENV === "development" && env.LOG_LEVEL === "trace",
  });

  await app.register(openApiPlugin, {
    apiBaseUrl: env.API_BASE_URL,
    exposeUi: !isProduction,
  });

  // --- Identity and tenancy (Epic 1) ---------------------------------------
  // Order matters and is enforced by each plugin's `dependencies`:
  //   auth            resolves *who* you are
  //   tenant-context  resolves *where* you are, and your standing there
  //   authorization   decides *whether* you may
  await app.register(authPlugin, {
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: env.API_BASE_URL,
    appUrl: env.APP_BASE_URL,
    // Cross-site cookies require HTTPS; on http://localhost they must not be
    // marked secure or the browser silently drops them.
    secureCookies: env.API_BASE_URL.startsWith("https://"),
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : undefined,
  });

  await app.register(tenantContextPlugin);
  await app.register(authorizationPlugin);
  await app.register(auditPlugin);

  // --- Modules --------------------------------------------------------------
  const startedAt = Date.now();

  await app.register(healthRoutes, {
    prefix: "/health",
    redis: rateLimitRedis,
    version: API_VERSION,
    startedAt,
  });

  await app.register(meRoutes, { prefix: "/v1/me" });
  await app.register(tenantRoutes, { prefix: "/v1/tenants" });
  await app.register(membershipRoutes, {
    prefix: "/v1/members",
    invitationExpiryHours: env.INVITATION_EXPIRY_HOURS,
    appBaseUrl: env.APP_BASE_URL,
  });
  // Outside the tenant-scoped prefix: whoever is accepting is not a member yet,
  // so no tenant context can be resolved for them.
  await app.register(invitationAcceptRoutes, { prefix: "/v1/invitations" });

  // --- Platform administration (Epic 9) -------------------------------------
  // Also outside the tenant-scoped tree: these routes are *about* tenants
  // rather than *within* one, so they carry no X-Tenant-Id. Guarded by the
  // platform-admin user flag, not by a permission — see platform.routes.ts.
  await app.register(platformRoutes, {
    prefix: "/v1/platform",
    appBaseUrl: env.APP_BASE_URL,
    onboardingWindowDays: env.ONBOARDING_WINDOW_DAYS,
    invitationExpiryHours: env.INVITATION_EXPIRY_HOURS,
  });

  // --- Billing (Epic 9) -----------------------------------------------------
  // Deliberately NOT behind requireWritableTenant: subscribing is itself a
  // write, and a PENDING_SUBSCRIPTION tenant accepts none, so gating it would
  // make the state unescapable (phase-9 §2.4). See billing.routes.ts.
  await app.register(billingRoutes, {
    prefix: "/v1/billing",
    // A plan is its price. Links are built from these per organization rather
    // than held in config as four permanent URLs — the change that made it
    // possible to stop one organization paying twice
    // (docs/phase-9-duplicate-subscription-prevention.md §4).
    planPrices: {
      ...(env.STRIPE_PRICE_STARTER === undefined ? {} : { STARTER: env.STRIPE_PRICE_STARTER }),
      ...(env.STRIPE_PRICE_PROFESSIONAL === undefined
        ? {}
        : { PROFESSIONAL: env.STRIPE_PRICE_PROFESSIONAL }),
    },
    trialPeriodDays: env.TRIAL_PERIOD_DAYS,
    // Both billing features now need a live Stripe call, so both disappear
    // together when there is no key — the routes stay registered and answer
    // 503, rather than 404, because the difference between "not configured" and
    // "does not exist" matters to whoever is reading the logs
    // (phase-9-customer-portal.md §2.1).
    ...(env.STRIPE_SECRET_KEY === undefined
      ? {}
      : {
          paymentLinkClient: createStripePaymentLinkClient({ secretKey: env.STRIPE_SECRET_KEY }),
          createPortalSession: createStripePortalSession({ secretKey: env.STRIPE_SECRET_KEY }),
        }),
    // After the spread, so a supplied stub wins over the real client.
    ...(options.paymentLinkClient === undefined
      ? {}
      : { paymentLinkClient: options.paymentLinkClient }),
    // The base only. Where Stripe returns the owner to — and in which language
    // — is decided per organization inside the service, because the locale
    // segment comes from the tenant
    // (docs/phase-9-owner-language-and-return-paths.md §4).
    appBaseUrl: env.APP_BASE_URL,
  });

  // Registered only when Stripe is configured. Rule 4 in its literal form: with
  // no key there is nothing that could verify a signature, and a route that
  // accepted unverified webhooks would be worse than no route at all.
  if (env.STRIPE_SECRET_KEY !== undefined && env.STRIPE_WEBHOOK_SECRET !== undefined) {
    await app.register(stripeWebhookRoutes, {
      prefix: "/v1/webhooks",
      stripeSecretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    });
  }

  // --- Catalogue (Epic 2) ---------------------------------------------------
  // Staff routes. Every one of them resolves a tenant from the X-Tenant-Id
  // header and an ACTIVE membership before doing anything.
  await app.register(providerRoutes, {
    prefix: "/v1/providers",
    // For POST /:providerId/invitation — the same two the membership routes
    // take, because it issues the same kind of invitation.
    invitationExpiryHours: env.INVITATION_EXPIRY_HOURS,
    appBaseUrl: env.APP_BASE_URL,
  });
  await app.register(serviceRoutes, { prefix: "/v1/services" });
  await app.register(locationRoutes, { prefix: "/v1/locations" });

  // --- Calendar integrations (Epic 6, part 1) — PARKED 2026-08-17 -----------
  // Deferred for delivery time, not abandoned: the module under
  // `modules/integrations/` is complete and still compiles, it is simply not
  // mounted, so `/v1/integrations/*` 404s rather than 503s. Un-parking is this
  // block plus the two imports above — nothing else in this file changed.
  // What the code review found before it goes live: the OAuth scope set asks
  // for `calendar.events` but the picker calls `calendarList.list`, which that
  // scope does not authorize (docs/google-calendar-feature-code-review.md).
  //
  // await app.register(integrationRoutes, {
  //   prefix: "/v1/integrations",
  //   appBaseUrl: env.APP_BASE_URL,
  //   stateTtlMinutes: env.CALENDAR_OAUTH_STATE_TTL_MINUTES,
  //   backfillLimit: env.CALENDAR_BACKFILL_LIMIT,
  //   // All four variables or none: `hasGoogleCalendar` is the single question,
  //   // and the schema's superRefine has already refused the half-configurations.
  //   // The key is parsed here, at boot, so a malformed one fails the deployment
  //   // rather than the first provider's callback.
  //   ...(hasGoogleCalendar(env)
  //     ? {
  //         google: {
  //           clientId: env.GOOGLE_CLIENT_ID!,
  //           clientSecret: env.GOOGLE_CLIENT_SECRET!,
  //           redirectUri: env.GOOGLE_REDIRECT_URI!,
  //           encryptionKey: parseEncryptionKey(env.GOOGLE_TOKEN_ENCRYPTION_KEY!),
  //         },
  //         googleOAuthClient: getGoogleOAuth({
  //           clientId: env.GOOGLE_CLIENT_ID!,
  //           clientSecret: env.GOOGLE_CLIENT_SECRET!,
  //           redirectUri: env.GOOGLE_REDIRECT_URI!,
  //         }),
  //         // Holds no credentials of its own — every call takes an access token,
  //         // because only the caller can persist a refreshed one.
  //         googleCalendarClient: createGoogleCalendarClient(),
  //       }
  //     : {}),
  //   // After the spread, so a supplied stub wins over the real client.
  //   ...(options.googleOAuthClient === undefined
  //     ? {}
  //     : { googleOAuthClient: options.googleOAuthClient }),
  //   ...(options.googleCalendarClient === undefined
  //     ? {}
  //     : { googleCalendarClient: options.googleCalendarClient }),
  // });

  // --- Availability (Epic 3) ------------------------------------------------
  // Registered at the version root rather than under a prefix: its routes hang
  // off two different nouns (`/v1/providers/:id/working-hours` and
  // `/v1/availability-exceptions/:id`), which is what tech-impl §17 specifies.
  await app.register(availabilityRoutes, { prefix: "/v1" });

  // --- Diary delegation -----------------------------------------------------
  // docs/phase-3-4-diary-delegation.md. Two plugins from one module, the way
  // memberships splits its tenant-scoped routes from the acceptance ones: the
  // write surface hangs off the diary being granted, and the delegate's own
  // view hangs off the caller.
  await app.register(providerDelegationRoutes, {
    prefix: "/v1",
    // For POST /providers/:providerId/delegations/invitation — the same two the
    // other invitation routes take, because it issues the same kind of link.
    invitationExpiryHours: env.INVITATION_EXPIRY_HOURS,
    appBaseUrl: env.APP_BASE_URL,
  });
  await app.register(myDelegationRoutes, { prefix: "/v1/me" });

  // --- Bookings (Epic 4) ----------------------------------------------------
  await app.register(bookingRoutes, { prefix: "/v1/bookings" });

  // The public booking catalogue: no session, tenant addressed by slug. The
  // active/archived/assigned filters in catalogue.service.ts are what keep an
  // unfinished catalogue off the internet.
  await app.register(publicCatalogueRoutes, { prefix: "/v1/public" });

  // Holds, confirmation and the management-link endpoints. Same prefix, its own
  // plugin: what a stranger may send is decided by one file whose response
  // schemas are declared separately from the staff ones (CLAUDE.md rule 12).
  await app.register(publicBookingRoutes, { prefix: "/v1/public" });

  return app;
}
