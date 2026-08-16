import type { PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";
import {
  buildGoogleCalendarUrl,
  checkStillOwed,
  decideRetry,
  NotificationTypes,
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
  type BookingValues,
  type Locale,
  type NotificationType,
  type RenderedEmail,
} from "@bam/notification-engine";

import type { EmailProvider } from "../email/email.provider.js";

/**
 * Turns a `notifications` row into a sent message. tech-impl §26.2, §27.
 *
 * The row is the commitment; this is the attempt. Everything about *whether* to
 * try again lives in @bam/notification-engine (§26.3) — this module only
 * performs the I/O and records what happened.
 *
 * ## Claiming
 *
 * A job could arrive twice: BullMQ redelivers, and the sweep in part 3 will
 * also pick up anything still PENDING. So the row is claimed with a conditional
 * update — PENDING → SENDING, matching on the current status — and a claim that
 * updates zero rows means somebody else has it. Same shape as the outbox claim,
 * and for the same reason: a read followed by a write has a window in it.
 */

export interface SendNotificationOptions {
  prisma: PrismaClient;
  provider: EmailProvider;
  logger: Logger;
  maxAttempts: number;
}

export type SendOutcome =
  | "SENT"
  | "SKIPPED"
  | "RETRY"
  | "FAILED"
  /** Another worker holds it, or it is already sent. Not an error. */
  | "NOT_CLAIMED";

export async function sendNotification(
  args: { tenantId: string; notificationId: string },
  options: SendNotificationOptions,
): Promise<SendOutcome> {
  const claimed = await claim(options.prisma, args);
  if (claimed === 0) return "NOT_CLAIMED";

  const notification = await options.prisma.notification.findFirst({
    where: { id: args.notificationId, tenantId: args.tenantId },
  });

  if (!notification) return "NOT_CLAIMED";

  const built = await build(notification, options);

  if ("skipped" in built) {
    // No template, values missing, or a booking that has moved on. None is
    // fixable by trying again, and SKIPPED rather than FAILED keeps the
    // dead-letter queue meaningful.
    await options.prisma.notification.update({
      where: { id: notification.id },
      data: { status: "SKIPPED", lastError: built.skipped },
    });
    return "SKIPPED";
  }

  const email = built.email;

  const result = await options.provider.send({
    to: notification.recipient,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });

  if (result.ok && !options.provider.delivers) {
    // The logging provider accepted it and nothing left the building. Recording
    // SENT here is what made five onboarding emails look delivered while Resend
    // had never been called — `provider_message_id` was the only tell, and
    // nobody reads a null.
    //
    // SKIPPED rather than FAILED for the same reason a missing template is:
    // retrying cannot fix it, and the dead-letter queue should mean something.
    // The payload is deliberately *not* cleared — in this mode the link in it
    // is the only copy anyone has.
    await options.prisma.notification.update({
      where: { id: notification.id },
      data: {
        status: "SKIPPED",
        lastError: "no email provider configured; body written to the log",
      },
    });

    options.logger.warn(
      { notificationId: notification.id, type: notification.type },
      "notification: not delivered — no email provider configured",
    );

    return "SKIPPED";
  }

  if (result.ok) {
    await options.prisma.notification.update({
      where: { id: notification.id },
      data: {
        status: "SENT",
        sentAt: new Date(),
        providerMessageId: result.providerMessageId ?? null,
        lastError: null,
        // The invitation link has served its purpose; holding it any longer is
        // exposure with no upside (see the column comment in schema.prisma).
        payload: {},
      },
    });

    options.logger.info(
      {
        notificationId: notification.id,
        type: notification.type,
        provider: options.provider.name,
        providerMessageId: result.providerMessageId,
      },
      "notification: sent",
    );

    return "SENT";
  }

  const decision = decideRetry({
    signal: { statusCode: result.statusCode, code: result.code },
    attempts: notification.attempts + 1,
    maxAttempts: options.maxAttempts,
  });

  await options.prisma.notification.update({
    where: { id: notification.id },
    data: {
      // Back to PENDING so the sweep and a BullMQ retry both find it; FAILED is
      // terminal and means a human should look.
      status: decision.retry ? "PENDING" : "FAILED",
      lastError: `${decision.reason}: ${result.message}`.slice(0, 1_000),
    },
  });

  options.logger[decision.retry ? "warn" : "error"](
    {
      notificationId: notification.id,
      attempts: notification.attempts + 1,
      kind: decision.classification.kind,
      reason: decision.reason,
    },
    decision.retry ? "notification: send failed, will retry" : "notification: send failed, parked",
  );

  // Rethrowing is what tells BullMQ to apply its backoff. A permanent failure
  // is already recorded and must not be retried, so it returns normally.
  if (decision.retry) throw new Error(`notification send failed: ${decision.reason}`);

  return "FAILED";
}

/**
 * PENDING → SENDING, atomically.
 *
 * `updateMany` with the status in the predicate is the whole trick: PostgreSQL
 * decides who wins, and the loser sees zero rows updated. `attempts` increments
 * here rather than on failure so that a worker killed mid-send still counts its
 * try and cannot loop forever.
 */
async function claim(
  prisma: PrismaClient,
  args: { tenantId: string; notificationId: string },
): Promise<number> {
  const { count } = await prisma.notification.updateMany({
    where: { id: args.notificationId, tenantId: args.tenantId, status: "PENDING" },
    data: { status: "SENDING", attempts: { increment: 1 } },
  });

  return count;
}

interface RenderableNotification {
  id: string;
  type: string;
  locale: string;
  /** Greeting somebody by their own address beats greeting them by nothing. */
  recipient: string;
  payload: unknown;
}

interface BookingNotificationRow extends RenderableNotification {
  tenantId: string;
  bookingId: string | null;
}

type BuildResult = { email: RenderedEmail } | { skipped: string };

/**
 * Which types are about a booking, and therefore go through the path that
 * re-reads one.
 */
const BOOKING_TYPES = new Set<string>([
  NotificationTypes.BOOKING_REQUESTED,
  NotificationTypes.BOOKING_CONFIRMATION,
  NotificationTypes.BOOKING_UPDATED,
  NotificationTypes.BOOKING_CANCELLED,
  NotificationTypes.BOOKING_REMINDER,
]);

async function build(
  notification: BookingNotificationRow,
  options: SendNotificationOptions,
): Promise<BuildResult> {
  if (BOOKING_TYPES.has(notification.type)) {
    return buildBookingEmail(notification, options);
  }

  const email = render(notification, options.logger);
  return email === undefined ? { skipped: "no renderable template or payload" } : { email };
}

/**
 * A booking email, rendered from the booking as it is now.
 *
 * Everything the onboarding emails carry in their payload, this reads instead —
 * the appointment, who it is with, where, what it costs. The payload holds only
 * what cannot be re-derived: a link built from a token that is no longer stored,
 * and the time an appointment used to be at
 * (docs/phase-5-booking-notifications.md §2.1, §2.3).
 *
 * That matters most for the reminder. It was planned when the booking was made
 * and runs a day before the appointment, so `checkStillOwed` is asked first:
 * a booking cancelled overnight owes nobody a reminder, and sending one is worse
 * than sending nothing.
 */
async function buildBookingEmail(
  notification: BookingNotificationRow,
  options: SendNotificationOptions,
): Promise<BuildResult> {
  if (notification.bookingId === null) {
    return { skipped: "booking notification with no booking" };
  }

  // Scoped by tenant like every read (rule 5), even though the notification row
  // and the booking are both already tenant-owned.
  const booking = await options.prisma.booking.findFirst({
    where: { id: notification.bookingId, tenantId: notification.tenantId },
    select: {
      status: true,
      reference: true,
      startAt: true,
      // Only the confirmation email uses it, and only to size the calendar
      // event — every printed time comes from `startAt`.
      endAt: true,
      customerNameSnapshot: true,
      serviceNameSnapshot: true,
      priceMinorSnapshot: true,
      currencySnapshot: true,
      provider: { select: { displayName: true, timezone: true } },
      location: {
        select: { name: true, addressLine1: true, city: true, timezone: true },
      },
      tenant: { select: { name: true, cancellationPolicy: true, defaultTimezone: true } },
    },
  });

  if (booking === null) {
    // Nothing to send and nothing to retry — a booking that has gone never comes
    // back, so this is SKIPPED rather than a failure worth an attempt budget.
    return { skipped: "booking no longer exists" };
  }

  const owed = checkStillOwed({
    type: notification.type as NotificationType,
    bookingStatus: booking.status,
  });

  if (!owed.owed) return { skipped: `no longer owed: ${owed.reason}` };

  const locale: Locale = notification.locale === "en" ? "en" : "hu";

  // The appointment's own zone, resolved the way the availability engine
  // resolves it: the location if the booking names one — a chain can have a
  // branch across a border — then the provider, then the tenant's default
  // (tech-impl §13.4). Never the recipient's, which we do not know.
  const timeZone =
    booking.location?.timezone ?? booking.provider.timezone ?? booking.tenant.defaultTimezone;

  const payload = notification.payload as {
    manageUrl?: string;
    bookingUrl?: string;
    previousStartAt?: string;
  } | null;

  const values: BookingValues = {
    organizationName: booking.tenant.name,
    // The snapshots, not the current catalogue rows: a booking records what the
    // customer was told (rule 15), and an email about it must say the same.
    customerName: booking.customerNameSnapshot,
    serviceName: booking.serviceNameSnapshot,
    providerName: booking.provider.displayName,
    when: formatInstant(booking.startAt, locale, timeZone),
    locationName: booking.location?.name ?? null,
    locationAddress: addressOf(booking.location),
    price: formatMoney(booking.priceMinorSnapshot, booking.currencySnapshot, locale),
    reference: booking.reference,
  };

  switch (notification.type) {
    case NotificationTypes.BOOKING_REQUESTED:
      return {
        email: renderBookingRequested(locale, { ...values, manageUrl: payload?.manageUrl ?? null }),
      };

    case NotificationTypes.BOOKING_CONFIRMATION:
      return {
        email: renderBookingConfirmation(locale, {
          ...values,
          manageUrl: payload?.manageUrl ?? null,
          cancellationPolicy: booking.tenant.cancellationPolicy,
          // Built from the instants rather than from `values.when`, which is
          // already a string in the clinic's zone. calendar.ts explains why the
          // two deliberately disagree about zones.
          addToCalendarUrl: buildGoogleCalendarUrl(locale, {
            organizationName: booking.tenant.name,
            serviceName: booking.serviceNameSnapshot,
            providerName: booking.provider.displayName,
            locationName: booking.location?.name ?? null,
            locationAddress: addressOf(booking.location),
            reference: booking.reference,
            startAt: booking.startAt,
            endAt: booking.endAt,
          }),
        }),
      };

    case NotificationTypes.BOOKING_UPDATED:
      return {
        email: renderBookingUpdated(locale, {
          ...values,
          previousWhen:
            payload?.previousStartAt === undefined
              ? null
              : formatInstant(new Date(payload.previousStartAt), locale, timeZone),
        }),
      };

    case NotificationTypes.BOOKING_CANCELLED:
      return {
        email: renderBookingCancelled(locale, {
          ...values,
          bookingUrl: payload?.bookingUrl ?? null,
        }),
      };

    default:
      return { email: renderBookingReminder(locale, values) };
  }
}

/** Street and town, or nothing. A clinic with one site may record neither. */
function addressOf(
  location: { addressLine1: string | null; city: string | null } | null,
): string | null {
  if (location === null) return null;

  const parts = [location.addressLine1, location.city].filter(
    (part): part is string => part !== null && part !== "",
  );

  return parts.length === 0 ? null : parts.join(", ");
}

/**
 * A date and time a person can read, in the appointment's zone.
 *
 * `dateStyle: "full"` rather than "long" on purpose: it includes the weekday,
 * and "Thursday" is what a customer actually checks an appointment against.
 */
function formatInstant(instant: Date, locale: Locale, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(locale === "hu" ? "hu-HU" : "en-GB", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone,
    }).format(instant);
  } catch {
    // An unrecognised IANA zone throws. Falling back to UTC keeps the email
    // sendable and wrong by a known amount, which beats not sending it.
    return new Intl.DateTimeFormat(locale === "hu" ? "hu-HU" : "en-GB", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(instant);
  }
}

function render(notification: RenderableNotification, logger: Logger): RenderedEmail | undefined {
  const locale = notification.locale === "en" ? "en" : "hu";

  if (notification.type === NotificationTypes.ORGANIZATION_CREATED) {
    const payload = notification.payload as {
      organizationName?: string;
      ownerName?: string;
      acceptUrl?: string;
      expiresAt?: string | null;
    } | null;

    if (!payload?.acceptUrl || !payload.organizationName) {
      logger.error(
        { notificationId: notification.id },
        "notification: provisioning payload is missing; cannot render",
      );
      return undefined;
    }

    return renderOrganizationCreated(locale, {
      organizationName: payload.organizationName,
      ownerName: payload.ownerName ?? payload.organizationName,
      acceptUrl: payload.acceptUrl,
      expiresAt: formatExpiry(payload.expiresAt ?? null, locale),
    });
  }

  if (notification.type === NotificationTypes.PROVIDER_INVITED) {
    const payload = notification.payload as {
      organizationName?: string;
      providerName?: string;
      invitedByName?: string | null;
      acceptUrl?: string;
      expiresAt?: string | null;
    } | null;

    if (!payload?.acceptUrl || !payload.organizationName) {
      logger.error(
        { notificationId: notification.id },
        "notification: provider invitation payload is missing; cannot render",
      );
      return undefined;
    }

    return renderProviderInvited(locale, {
      organizationName: payload.organizationName,
      providerName: payload.providerName ?? notification.recipient,
      // Credit the organization when nobody's name was captured — a reissue
      // stores none. Never left blank: "  has invited you" reads as a bug.
      invitedByName: payload.invitedByName ?? payload.organizationName,
      acceptUrl: payload.acceptUrl,
      expiresAt: formatExpiry(payload.expiresAt ?? null, locale),
    });
  }

  if (notification.type === NotificationTypes.SUBSCRIPTION_LINK) {
    const payload = notification.payload as {
      organizationName?: string;
      recipientName?: string | null;
      planName?: string;
      paymentUrl?: string;
    } | null;

    if (!payload?.paymentUrl || !payload.organizationName) {
      logger.error(
        { notificationId: notification.id },
        "notification: subscription payload is missing; cannot render",
      );
      return undefined;
    }

    return renderSubscriptionLink(locale, {
      organizationName: payload.organizationName,
      // Falls back to the organization rather than to an empty greeting; the
      // recipient's name is not always known.
      recipientName: payload.recipientName ?? payload.organizationName,
      planName: payload.planName ?? "",
      paymentUrl: payload.paymentUrl,
    });
  }

  if (notification.type === NotificationTypes.SUBSCRIPTION_CONFIRMED) {
    const payload = notification.payload as {
      organizationName?: string;
      recipientName?: string | null;
      planName?: string;
      trial?: boolean;
      renewsAt?: string | null;
      dashboardUrl?: string;
    } | null;

    if (!payload?.organizationName || !payload.dashboardUrl) {
      logger.error(
        { notificationId: notification.id },
        "notification: confirmation payload is missing; cannot render",
      );
      return undefined;
    }

    return renderSubscriptionConfirmed(locale, {
      organizationName: payload.organizationName,
      recipientName: payload.recipientName ?? payload.organizationName,
      planName: payload.planName ?? "",
      trial: payload.trial === true,
      // Empty when Stripe named no date, which drops the charge line rather
      // than inventing one — see the template's note on why that line matters.
      renewsOn: formatExpiry(payload.renewsAt ?? null, locale),
      dashboardUrl: payload.dashboardUrl,
    });
  }

  if (notification.type === NotificationTypes.TRIAL_ENDING_SOON) {
    const payload = notification.payload as {
      organizationName?: string;
      recipientName?: string | null;
      planName?: string;
      trialEndsAt?: string | null;
      billingUrl?: string;
    } | null;

    if (!payload?.organizationName || !payload.billingUrl) {
      logger.error(
        { notificationId: notification.id },
        "notification: trial payload is missing; cannot render",
      );
      return undefined;
    }

    return renderTrialEnding(locale, {
      organizationName: payload.organizationName,
      recipientName: payload.recipientName ?? payload.organizationName,
      planName: payload.planName ?? "",
      trialEndsOn: formatExpiry(payload.trialEndsAt ?? null, locale),
      billingUrl: payload.billingUrl,
    });
  }

  if (notification.type === NotificationTypes.SUBSCRIPTION_PAYMENT_FAILED) {
    const payload = notification.payload as {
      organizationName?: string;
      recipientName?: string | null;
      amountDueMinor?: number | null;
      currency?: string | null;
      billingUrl?: string;
    } | null;

    if (!payload?.organizationName || !payload.billingUrl) {
      logger.error(
        { notificationId: notification.id },
        "notification: payment-failed payload is missing; cannot render",
      );
      return undefined;
    }

    return renderPaymentFailed(locale, {
      organizationName: payload.organizationName,
      recipientName: payload.recipientName ?? payload.organizationName,
      amount: formatMoney(payload.amountDueMinor ?? null, payload.currency ?? null, locale),
      billingUrl: payload.billingUrl,
    });
  }

  // Booking types never reach here — `build` sends them down the path that
  // re-reads the booking. What is left is a type in the schema with no renderer,
  // which is `CALENDAR_DISCONNECTED` until Epic 6.
  logger.warn(
    { notificationId: notification.id, type: notification.type },
    "notification: no template for this type yet",
  );

  return undefined;
}

/** A date a person can read, in their own language. */
function formatExpiry(iso: string | null, locale: Locale): string {
  if (iso === null) return "";

  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "";

  return new Intl.DateTimeFormat(locale === "hu" ? "hu-HU" : "en-GB", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Budapest",
  }).format(new Date(parsed));
}

/**
 * An amount a person can read, or nothing.
 *
 * Minor units and currency travel together or not at all — the same pairing
 * rule 15 enforces on a booking's price snapshot, for the same reason: a number
 * without its currency is a number that will eventually be shown with the wrong
 * symbol. Returning null when either is missing lets the template drop the line
 * rather than print "the amount due is null".
 *
 * `minimumFractionDigits: 0` is not assumed: Intl already knows HUF has no
 * minor unit and EUR has two, which is exactly the trap `priceMinor` fell into
 * in the seed.
 */
function formatMoney(minor: number | null, currency: string | null, locale: Locale): string | null {
  if (minor === null || currency === null || currency === "") return null;

  try {
    const formatter = new Intl.NumberFormat(locale === "hu" ? "hu-HU" : "en-GB", {
      style: "currency",
      currency,
    });
    // Typed optional, always present for `style: "currency"`. The fallback of 2
    // is never reached in practice; HUF resolves to 0 here, which is the whole
    // point of asking Intl rather than assuming.
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;

    return formatter.format(minor / 10 ** digits);
  } catch {
    // An unknown currency code throws rather than degrading. Dropping the line
    // is better than failing an email about a failed payment.
    return null;
  }
}
