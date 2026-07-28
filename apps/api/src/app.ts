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
import { healthRoutes } from "./modules/health/health.routes.js";

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
  await app.register(cors, {
    origin: [env.APP_BASE_URL],
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id"],
  });

  // In-process store for now. Epic 5 swaps in Redis so limits hold across
  // instances — until then, limits are per-instance and that is a known gap.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
  });

  await app.register(databasePlugin, {
    databaseUrl: env.DATABASE_URL,
    logQueries: env.NODE_ENV === "development" && env.LOG_LEVEL === "trace",
  });

  await app.register(openApiPlugin, {
    apiBaseUrl: env.API_BASE_URL,
    exposeUi: !isProduction,
  });

  // --- Modules --------------------------------------------------------------
  const startedAt = Date.now();

  await app.register(healthRoutes, {
    prefix: "/health",
    redisUrl: env.REDIS_URL,
    version: API_VERSION,
    startedAt,
  });

  return app;
}
