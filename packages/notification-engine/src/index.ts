/**
 * @bam/notification-engine — what to send, to whom, when, and whether to try
 * again. tech-impl §26.2, §26.3, §27.
 *
 * Like @bam/availability-engine and @bam/booking-engine, this package has **no
 * runtime dependencies** and imports no Fastify, Prisma, Redis, HTTP client or
 * email SDK (CLAUDE.md rule 8).
 *
 * ## The split
 *
 * Epic 5's work divides cleanly along the same seam Epics 3 and 4 used. The
 * parts that are decisions about values live here:
 *
 *   - which messages an outbox event owes, and to whom (`planning.ts`);
 *   - the identity that makes a message send exactly once (`dedupe.ts`);
 *   - which language it goes out in (`locale.ts`);
 *   - whether a failure is worth retrying, and how long to wait (`retry.ts`).
 *
 * The parts that are I/O — claiming outbox rows, publishing to BullMQ, calling
 * Resend, writing delivery status — live in apps/worker, where they can be
 * wrong in the ways I/O is wrong without making any of the above untestable.
 *
 * ## Once, not at-least-once
 *
 * The queue gives at-least-once delivery, and no arrangement of retries turns
 * that into exactly-once by itself. What does is `dedupeKey` plus the unique
 * index on `notifications(tenant_id, dedupe_key)`: the second insert loses, and
 * the loser has nothing to send. This is the same shape as capacity
 * reservations (rule 14) — the decision belongs to the database, and
 * application code's job is to translate the constraint violation, not to
 * check first and hope.
 */

export { buildGoogleCalendarUrl, calendarActionLabel } from "./calendar.js";
export type { CalendarEventInput } from "./calendar.js";

export { buildDedupeKey, utcDayOf } from "./dedupe.js";
export type { DedupeInput } from "./dedupe.js";

export { normalizeLocale, resolveLocale } from "./locale.js";
export type { LocaleCandidates } from "./locale.js";

export { checkStillOwed, OutboxEventTypes, planNotifications, SkipReasons } from "./planning.js";
export type {
  BookingNotificationFacts,
  NotificationPlan,
  NotificationPlanResult,
  OutboxEventType,
  PlanNotificationsInput,
  SkippedNotification,
  SkipReason,
} from "./planning.js";

export {
  escapeHtml,
  isRenderable,
  RENDERABLE_TYPES,
  renderBookingCancelled,
  renderBookingConfirmation,
  renderBookingReminder,
  renderBookingRequested,
  renderBookingUpdated,
  renderOrganizationCreated,
  renderPaymentFailed,
  renderProviderInvited,
  renderSubscriptionConfirmed,
  renderSubscriptionLink,
  renderTrialEnding,
} from "./templates.js";
export type {
  BookingCancelledValues,
  BookingConfirmationValues,
  BookingReminderValues,
  BookingRequestedValues,
  BookingUpdatedValues,
  BookingValues,
  OrganizationCreatedValues,
  PaymentFailedValues,
  ProviderInvitedValues,
  RenderedEmail,
  SubscriptionConfirmedValues,
  SubscriptionLinkValues,
  TrialEndingValues,
} from "./templates.js";

export { backoffDelayMs, classifyFailure, decideRetry, FailureKinds } from "./retry.js";
export type {
  BackoffOptions,
  FailureClassification,
  FailureKind,
  FailureSignal,
  RetryDecision,
  RetryDecisionInput,
} from "./retry.js";

export {
  FALLBACK_LOCALE,
  NotificationChannels,
  NotificationTypes,
  planned,
  SUPPORTED_LOCALES,
  unplanned,
} from "./types.js";
export type { Locale, NotificationChannel, NotificationType, Planned } from "./types.js";
