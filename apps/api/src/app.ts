import Fastify, {
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from "fastify";

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

  // --- Catalogue (Epic 2) ---------------------------------------------------
  // Staff routes. Every one of them resolves a tenant from the X-Tenant-Id
  // header and an ACTIVE membership before doing anything.
  await app.register(providerRoutes, { prefix: "/v1/providers" });
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
