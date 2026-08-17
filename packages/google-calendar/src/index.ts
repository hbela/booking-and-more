/**
 * @bam/google-calendar — Google's OAuth and Calendar APIs, and the decisions
 * about them that are worth testing without a network.
 * docs/phase-6-google-calendar-part-1.md.
 *
 * ## Why `fetch` and not `googleapis`
 *
 * The opposite call to the one made for Stripe, and the same one made for
 * Resend — so the reasoning matters (§2.7). Stripe earned its SDK: dozens of
 * resources, webhook signature verification, a large typed surface. This is six
 * endpoints.
 *
 * Against that, `googleapis` is a very large dependency, and it flattens
 * failures into its own error classes. That flattening is the deciding
 * objection, because the failure *shape* is the product here: tech-impl §26.3
 * requires that `invalid_grant`, an invalid calendar id and permission-denied
 * are never retried, and 403 is not one thing — `rateLimitExceeded` must retry
 * while `insufficientPermissions` must not. Telling those apart needs the status
 * code and the `reason` field, which is exactly what an SDK error class loses.
 *
 * ## The split inside
 *
 * `google.events.ts` and `google.errors.ts` are pure and carry every decision:
 * the derived event id that makes creation idempotent, what a booking looks like
 * as an event, and whether a failure is worth another attempt. `google.oauth.ts`
 * and `google.calendar.ts` do the I/O and hold no policy.
 *
 * Nothing in this package logs. Every module here handles a bearer credential
 * for somebody's calendar.
 */

export {
  buildBookingEvent,
  buildCancellationPatch,
  deriveEventId,
  type BookingEventInput,
  type GoogleEventBody,
} from "./google.events.js";

export {
  classifyGoogleFailure,
  classifyUnknown,
  GoogleApiError,
  GoogleFailureKinds,
  googleBackoffMs,
  isGoogleApiError,
  needsReconnect,
  type GoogleFailureClassification,
  type GoogleFailureKind,
  type GoogleFailureSignal,
} from "./google.errors.js";

export {
  buildAuthorizationUrl,
  createGoogleOAuthClient,
  errorFrom,
  GOOGLE_CALENDAR_SCOPES,
  type GoogleOAuthClient,
  type GoogleOAuthConfig,
  type GoogleTokenSet,
} from "./google.oauth.js";

export {
  createGoogleCalendarClient,
  type GoogleCalendarClient,
  type GoogleCalendarSummary,
  type GoogleEventResult,
} from "./google.calendar.js";

export { ACCESS_TOKEN_SKEW_MS, isAccessTokenStale } from "./google.tokens.js";
