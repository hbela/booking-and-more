/**
 * Sentry initialisation.
 *
 * Imported first in server.ts, before Fastify or Prisma, so Sentry's
 * auto-instrumentation can patch them. Importing this later means silently
 * losing most tracing — the reason sunshine-dental keeps the same file at the
 * top of its entry point.
 */
import { loadEnvOrExit } from "@bam/config";
import { initSentry } from "@bam/observability";

const env = loadEnvOrExit();

initSentry({
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
  service: "api",
});

export { env };
