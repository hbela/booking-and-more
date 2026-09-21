import * as Sentry from "@sentry/nextjs";
import { API_BASE_URL } from "./lib/api-origin";
import { apiTraceTarget, privacyOptions } from "./lib/sentry-options";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    ...privacyOptions,
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "development",
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    tracePropagationTargets: [/^\//u, apiTraceTarget(API_BASE_URL)],
    integrations: [
      Sentry.replayIntegration({ maskAllText: true, maskAllInputs: true, blockAllMedia: true }),
    ],
    replaysSessionSampleRate: 0.01,
    replaysOnErrorSampleRate: 1,
    dataCollection: { userInfo: false, httpBodies: [] },
  });
}
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
