import * as Sentry from "@sentry/nextjs";
import { privacyOptions } from "./src/lib/sentry-options";
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    ...privacyOptions,
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "development",
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    dataCollection: { userInfo: false, httpBodies: [] },
  });
}
