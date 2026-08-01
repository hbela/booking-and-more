import type { PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";
import {
  decideRetry,
  NotificationTypes,
  renderOrganizationCreated,
  renderPaymentFailed,
  renderSubscriptionLink,
  renderTrialEnding,
  type Locale,
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

  const email = render(notification, options.logger);

  if (email === undefined) {
    // No template, or values missing. Neither is fixable by trying again, and
    // SKIPPED rather than FAILED keeps the dead-letter queue meaningful.
    await options.prisma.notification.update({
      where: { id: notification.id },
      data: { status: "SKIPPED", lastError: "no renderable template or payload" },
    });
    return "SKIPPED";
  }

  const result = await options.provider.send({
    to: notification.recipient,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });

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
  payload: unknown;
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

  // Booking templates arrive in Epic 5 part 2's remaining work. Until then the
  // rows are written and left PENDING rather than half-sent.
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
