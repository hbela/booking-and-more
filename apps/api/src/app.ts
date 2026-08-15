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
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Env } from "@bam/config";
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
import { bookingRoutes } from "./modules/bookings/booking.routes.js";
import { publicCatalogueRoutes } from "./modules/public/catalogue.routes.js";
import { publicBookingRoutes } from "./modules/public/booking.routes.js";

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
    trustProxy: true,
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

  // In-process store for now. Epic 5 swaps in Redis so limits hold across
  // instances — until then, limits are per-instance and that is a known gap.
  if (options.rateLimit !== false) {
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: "1 minute",
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
    redisUrl: env.REDIS_URL,
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

  // --- Availability (Epic 3) ------------------------------------------------
  // Registered at the version root rather than under a prefix: its routes hang
  // off two different nouns (`/v1/providers/:id/working-hours` and
  // `/v1/availability-exceptions/:id`), which is what tech-impl §17 specifies.
  await app.register(availabilityRoutes, { prefix: "/v1" });

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
