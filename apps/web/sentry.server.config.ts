import * as Sentry from "@sentry/nextjs";
import { privacyOptions } from "./src/lib/sentry-options";
if (process.env.SENTRY_DSN) {
  Sentry.init({
    ...privacyOptions,
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? "development",
    release: process.env.SENTRY_RELEASE,
    dataCollection: { userInfo: false, httpBodies: [] },
  });
}
