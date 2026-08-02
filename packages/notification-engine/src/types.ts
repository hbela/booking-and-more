/**
 * Shared vocabulary for notification decisions. tech-impl §26.2, §27.
 *
 * These mirror the Prisma enums by value rather than importing them: this
 * package has no runtime dependencies, and taking one on @bam/db to reuse five
 * string literals would trade the property that makes the package testable for
 * nothing. `notification-engine.contract.test.ts` in @bam/db asserts the two
 * stay in step, so drift is a failing test rather than a runtime surprise.
 */

export const NotificationTypes = {
  BOOKING_CONFIRMATION: "BOOKING_CONFIRMATION",
  BOOKING_UPDATED: "BOOKING_UPDATED",
  BOOKING_CANCELLED: "BOOKING_CANCELLED",
  BOOKING_REMINDER: "BOOKING_REMINDER",
  CALENDAR_DISCONNECTED: "CALENDAR_DISCONNECTED",
  /** A newly provisioned organization's owner, with their acceptance link. */
  ORGANIZATION_CREATED: "ORGANIZATION_CREATED",
  /** The owner's Stripe payment link, forwardable to whoever pays. */
  SUBSCRIPTION_LINK: "SUBSCRIPTION_LINK",
  /** Three days before a free trial becomes a paid subscription. */
  TRIAL_ENDING_SOON: "TRIAL_ENDING_SOON",
  /** A declined renewal, while Stripe is still retrying. */
  SUBSCRIPTION_PAYMENT_FAILED: "SUBSCRIPTION_PAYMENT_FAILED",
  /** The subscription went live. One per Stripe subscription, ever. */
  SUBSCRIPTION_CONFIRMED: "SUBSCRIPTION_CONFIRMED",
} as const;

export type NotificationType = (typeof NotificationTypes)[keyof typeof NotificationTypes];

export const NotificationChannels = {
  EMAIL: "EMAIL",
  SMS: "SMS",
  PUSH: "PUSH",
} as const;

export type NotificationChannel = (typeof NotificationChannels)[keyof typeof NotificationChannels];

/**
 * BCP-47 subtags the platform has templates for. PRD §12.5 — Hungarian and
 * English at launch, Hungarian first because that is who the product is for.
 */
export const SUPPORTED_LOCALES = ["hu", "en"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Used when neither the customer nor the tenant expresses a usable preference. */
export const FALLBACK_LOCALE: Locale = "hu";

/**
 * Same shape as @bam/booking-engine's `Decision`, and for the same reason:
 * nothing here throws, so a caller branching on *why* a notification was not
 * planned does not have to catch and re-inspect an error.
 */
export type Planned<TValue, TReason extends string> =
  | { planned: true; value: TValue }
  | { planned: false; reason: TReason; detail?: Record<string, unknown> };

export function planned<TValue, TReason extends string>(value: TValue): Planned<TValue, TReason> {
  return { planned: true, value };
}

export function unplanned<TValue, TReason extends string>(
  reason: TReason,
  detail?: Record<string, unknown>,
): Planned<TValue, TReason> {
  return detail === undefined ? { planned: false, reason } : { planned: false, reason, detail };
}
