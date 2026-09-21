import { loadEnvOrExit } from "@bam/config";
import { initSentry } from "@bam/observability";

export const env = loadEnvOrExit();

initSentry({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
  release: env.SENTRY_RELEASE,
  tracesSampleRate: env.NODE_ENV === "production" ? 0.1 : 1,
  service: "worker",
});
