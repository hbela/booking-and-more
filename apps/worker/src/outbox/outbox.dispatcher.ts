import { buildAppUrl } from "@bam/contracts";
import { type Prisma, type PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";
import {
  backoffDelayMs,
  buildDedupeKey,
  NotificationChannels,
  NotificationTypes,
  planNotifications,
  resolveLocale,
  type BookingNotificationFacts,
  type NotificationPlan,
} from "@bam/notification-engine";

import {
  claimOutboxEvents,
  markFailed,
  markForRetry,
  markProcessed,
  type ClaimedOutboxEvent,
} from "./outbox.repository.js";
import { NotificationJobs, QueueNames, type QueueRegistry } from "../queues.js";

/**
 * Turns outbox rows into notification rows and queue jobs. tech-impl §12, §26.
 *
 * The chain is deliberately three links rather than one:
 *
 *   outbox_events  →  notifications  →  BullMQ job
 *   (the API owes    (the platform     (something should
 *    someone this)    owes this        send it now)
 *                     message)
 *
 * Each link is durable except the last, and the last is deliberately not. A
 * notification row is the commitment; the job is only a prompt to act on it.
 * If Redis loses every job in it, nothing is forgotten — the rows are still
 * there, PENDING, with a `scheduledAt` in the past, and the sweep added in
 * part 3 picks them up. That is what makes it safe to run this on a Redis
 * instance with no persistence.
 */

export interface DispatcherOptions {
  prisma: PrismaClient;
  queues: QueueRegistry;
  logger: Logger;
  batchSize: number;
  maxAttempts: number;
  reminderLeadHours: number;
  /** Origin of the web app, for links inside notifications. */
  appBaseUrl: string;
}

/**
 * How far ahead a notification is handed to BullMQ as a delayed job.
 *
 * Anything further out stays a database row until the sweep picks it up.
 * Delayed jobs live in a Redis sorted set for their whole delay, so scheduling
 * a reminder three weeks out means three weeks of Redis memory per booking —
 * on a small instance that is the dominant cost, and it buys nothing the row
 * does not already provide. Near-term jobs go to the queue because punctuality
 * to the second is worth having and a poll interval cannot give it.
 */
const MAX_QUEUE_LEAD_MS = 15 * 60 * 1_000;

/** Comfortably longer than a healthy batch; see ClaimOptions.staleClaimSeconds. */
const STALE_CLAIM_SECONDS = 300;

export interface DispatchSummary {
  claimed: number;
  processed: number;
  retried: number;
  failed: number;
  notificationsCreated: number;
  notificationsDuplicate: number;
}

/**
 * One pass. Returns what it did so the caller can decide whether to go round
 * again immediately — a full batch usually means more is waiting.
 */
export async function dispatchOutboxBatch(options: DispatcherOptions): Promise<DispatchSummary> {
  const summary: DispatchSummary = {
    claimed: 0,
    processed: 0,
    retried: 0,
    failed: 0,
    notificationsCreated: 0,
    notificationsDuplicate: 0,
  };

  const events = await claimOutboxEvents(options.prisma, {
    batchSize: options.batchSize,
    staleClaimSeconds: STALE_CLAIM_SECONDS,
  });

  summary.claimed = events.length;
  if (events.length === 0) return summary;

  for (const event of events) {
    try {
      const result = await dispatchOne(event, options);
      summary.notificationsCreated += result.created;
      summary.notificationsDuplicate += result.duplicate;

      await markProcessed(options.prisma, { tenantId: event.tenantId, eventId: event.id });
      summary.processed += 1;
    } catch (error) {
      await settleFailure(event, error, options);
      if (event.attempts >= options.maxAttempts) summary.failed += 1;
      else summary.retried += 1;
    }
  }

  return summary;
}

interface DispatchOneResult {
  created: number;
  duplicate: number;
}

/**
 * What `persistNotification` needs. Wider than `NotificationPlan` in two ways:
 * `bookingId` may be null (a provisioning email is about an organization, not a
 * booking), and `payload` carries values the sender cannot re-derive.
 */
interface PersistableNotification {
  type: NotificationPlan["type"];
  channel: NotificationPlan["channel"];
  template: string;
  locale: NotificationPlan["locale"];
  recipient: string;
  scheduledAtIso: string;
  dedupeKey: string;
  bookingId: string | null;
  customerId: string | null;
  payload?: Record<string, unknown>;
}

async function dispatchOne(
  event: ClaimedOutboxEvent,
  options: DispatcherOptions,
): Promise<DispatchOneResult> {
  if (event.aggregateType === "Tenant") {
    return dispatchTenantEvent(event, options);
  }

  if (event.aggregateType === "Provider") {
    return dispatchProviderEvent(event, options);
  }

  // Calendar-sync and usage events share the outbox and are not this
  // dispatcher's business — marking them processed without acting is correct
  // until their consumers exist.
  if (event.aggregateType !== "Booking") {
    options.logger.debug(
      { eventId: event.id, aggregateType: event.aggregateType },
      "outbox: no notification consumer for aggregate type",
    );
    return { created: 0, duplicate: 0 };
  }

  const loaded = await loadBookingFacts(options.prisma, {
    tenantId: event.tenantId,
    bookingId: event.aggregateId,
  });

  if (loaded === undefined) {
    // The booking is gone. Nothing to send and nothing to retry — a missing
    // aggregate never becomes present again, so retrying would burn the
    // attempt budget to reach the same conclusion five times.
    options.logger.warn(
      { eventId: event.id, bookingId: event.aggregateId },
      "outbox: booking no longer exists; event discarded",
    );
    return { created: 0, duplicate: 0 };
  }

  const { facts, tenantSlug } = loaded;

  const plan = planNotifications({
    eventType: event.eventType,
    facts,
    now: new Date(),
    reminderLeadHours: options.reminderLeadHours,
  });

  if (!plan.recognised) {
    options.logger.debug(
      { eventId: event.id, eventType: event.eventType },
      "outbox: event type has no notification mapping",
    );
    return { created: 0, duplicate: 0 };
  }

  for (const skipped of plan.skipped) {
    options.logger.info(
      { eventId: event.id, type: skipped.type, reason: skipped.reason },
      "outbox: notification deliberately not planned",
    );
  }

  // The raw management token, present only on the event the booking was created
  // by. Everything else about the booking is re-read above; this cannot be,
  // because only its SHA-256 hash is stored (phase-4 §3.3).
  const bookingPayload = event.payload as {
    managementToken?: string;
    previousStartAt?: string;
  } | null;

  let created = 0;
  let duplicate = 0;

  for (const notification of plan.plans) {
    const persisted = await persistNotification(options.prisma, event.tenantId, {
      ...notification,
      ...bookingPayloadFor(notification, {
        managementToken: bookingPayload?.managementToken,
        previousStartAtIso: bookingPayload?.previousStartAt,
        tenantSlug,
        appBaseUrl: options.appBaseUrl,
      }),
    });

    if (persisted === undefined) {
      duplicate += 1;
      continue;
    }

    created += 1;
    await enqueueIfDue(options, {
      tenantId: event.tenantId,
      notificationId: persisted.id,
      scheduledAtIso: notification.scheduledAtIso,
    });
  }

  return { created, duplicate };
}

/**
 * The little a booking email cannot re-derive at send time.
 *
 * Everything else is read from the booking when the job runs (§2.3). Three
 * things cannot be, and the rules are asymmetric enough to be worth stating in
 * one place — docs/phase-5-booking-notifications.md §2.1 and §2.2:
 *
 *   - a **manage** link needs the raw token, which exists only on the event that
 *     created the booking, so only the first email the customer receives can
 *     carry one;
 *   - a **reminder** deliberately gets none, because its row is written now and
 *     sent days later, and the URL would sit in `notifications.payload` for that
 *     whole period;
 *   - a **cancellation** offers the public booking page, which is not a
 *     credential and can be rebuilt from the slug at any time;
 *   - a **reschedule** carries where the appointment used to be, because by the
 *     time the worker reads the booking it has already moved.
 *
 * Locale comes from the plan, not the tenant: the notification's language was
 * resolved from the customer first, and a link that ignores that lands a
 * Hungarian-speaking customer on the English page (phase-9 §2).
 */
function bookingPayloadFor(
  plan: NotificationPlan,
  context: {
    managementToken: string | undefined;
    previousStartAtIso: string | undefined;
    tenantSlug: string;
    appBaseUrl: string;
  },
): { payload?: Record<string, unknown> } {
  if (
    plan.type === NotificationTypes.BOOKING_CONFIRMATION ||
    plan.type === NotificationTypes.BOOKING_REQUESTED
  ) {
    // Absent when staff accepted a pending request: that event carries no token,
    // and the confirmation template drops its button rather than linking nowhere.
    if (context.managementToken === undefined) return {};

    return {
      payload: {
        manageUrl: buildAppUrl({
          baseUrl: context.appBaseUrl,
          path: `/booking/manage/${context.managementToken}`,
          locale: plan.locale,
        }),
      },
    };
  }

  if (plan.type === NotificationTypes.BOOKING_UPDATED) {
    return context.previousStartAtIso === undefined
      ? {}
      : { payload: { previousStartAt: context.previousStartAtIso } };
  }

  if (plan.type === NotificationTypes.BOOKING_CANCELLED) {
    return {
      payload: {
        bookingUrl: buildAppUrl({
          baseUrl: context.appBaseUrl,
          path: `/${context.tenantSlug}/book`,
          locale: plan.locale,
        }),
      },
    };
  }

  return {};
}

/**
 * Organization provisioning. docs/phase-9-saas-administration.md §2.5.
 *
 * The payload is trusted here in a way a booking event's is not: it carries the
 * raw invitation token, which exists nowhere else, so this cannot re-read the
 * world the way `loadBookingFacts` does. That asymmetry is the price of never
 * storing the token, and it is why `markProcessed` clears the payload.
 */
async function dispatchTenantEvent(
  event: ClaimedOutboxEvent,
  options: DispatcherOptions,
): Promise<DispatchOneResult> {
  if (event.eventType === "SUBSCRIPTION_LINK_REQUESTED") {
    return dispatchSubscriptionLink(event, options);
  }

  if (event.eventType === "TRIAL_ENDING_SOON" || event.eventType === "SUBSCRIPTION_PAYMENT_FAILED") {
    return dispatchBillingNotice(event, options);
  }

  if (event.eventType === "SUBSCRIPTION_CONFIRMED") {
    return dispatchSubscriptionConfirmed(event, options);
  }

  if (event.eventType !== "ORGANIZATION_PROVISIONED") {
    options.logger.debug(
      { eventId: event.id, eventType: event.eventType },
      "outbox: tenant event has no notification mapping",
    );
    return { created: 0, duplicate: 0 };
  }

  const payload = event.payload as {
    ownerEmail?: string;
    /** Null on a reissue: an invitation stores no name. */
    ownerName?: string | null;
    invitationToken?: string;
    expiresAt?: string;
  } | null;

  const recipient = payload?.ownerEmail?.trim();
  const token = payload?.invitationToken;

  // A cleared payload means this event was already dispatched and re-claimed
  // after the clearing but before the status write — rare, and correctly a
  // no-op rather than an error, since the notification row already exists.
  if (recipient === undefined || recipient === "" || token === undefined) {
    options.logger.warn(
      { eventId: event.id },
      "outbox: provisioning event has no usable payload; already dispatched",
    );
    return { created: 0, duplicate: 0 };
  }

  const tenant = await options.prisma.tenant.findUnique({
    where: { id: event.aggregateId },
    select: { id: true, name: true, defaultLanguage: true },
  });

  if (tenant === null) {
    options.logger.warn(
      { eventId: event.id, tenantId: event.aggregateId },
      "outbox: organization no longer exists; event discarded",
    );
    return { created: 0, duplicate: 0 };
  }

  const scheduledAtIso = new Date().toISOString();

  const created = await persistNotification(options.prisma, event.tenantId, {
    type: NotificationTypes.ORGANIZATION_CREATED,
    channel: NotificationChannels.EMAIL,
    template: "organization-created",
    locale: resolveLocale({ tenantLanguage: tenant.defaultLanguage }),
    recipient,
    scheduledAtIso,
    dedupeKey: buildDedupeKey({
      type: NotificationTypes.ORGANIZATION_CREATED,
      channel: NotificationChannels.EMAIL,
      eventId: event.id,
    }),
    bookingId: null,
    customerId: null,
    // The link the sender cannot rebuild. Cleared once the email is away.
    payload: {
      organizationName: tenant.name,
      ownerName: payload?.ownerName ?? recipient,
      // Locale-prefixed, like every link we put in an email: the email is
      // already written in the organization's language and used to send them to
      // the Hungarian page regardless
      // (docs/phase-9-owner-language-and-return-paths.md §2).
      acceptUrl: buildAppUrl({
        baseUrl: options.appBaseUrl,
        path: `/invitations/${token}`,
        locale: tenant.defaultLanguage,
      }),
      expiresAt: payload?.expiresAt ?? null,
    },
  });

  if (created === undefined) return { created: 0, duplicate: 1 };

  await enqueueIfDue(options, {
    tenantId: event.tenantId,
    notificationId: created.id,
    scheduledAtIso,
  });

  return { created: 1, duplicate: 0 };
}

/**
 * A provider invited to set up their own login.
 * docs/phase-9-provider-onboarding.md §4.
 *
 * The one thing to get right here is which id means what. `aggregateId` is the
 * **provider**, unlike every Tenant handler above where it is the tenant — so
 * the tenant is read from `event.tenantId`. Copying one of those functions
 * without changing that line is the mistake this comment exists to prevent.
 *
 * The dedupe key is the event id, matching `ORGANIZATION_PROVISIONED`: each
 * re-invite is a new outbox row and legitimately earns a second email, because
 * a re-invite means the first one did not arrive.
 */
async function dispatchProviderEvent(
  event: ClaimedOutboxEvent,
  options: DispatcherOptions,
): Promise<DispatchOneResult> {
  if (event.eventType !== "PROVIDER_INVITED") {
    options.logger.debug(
      { eventId: event.id, eventType: event.eventType },
      "outbox: provider event has no notification mapping",
    );
    return { created: 0, duplicate: 0 };
  }

  const payload = event.payload as {
    email?: string;
    providerName?: string;
    /** Null when the inviter's name is unknown; the copy falls back. */
    invitedByName?: string | null;
    invitationToken?: string;
    expiresAt?: string;
  } | null;

  const recipient = payload?.email?.trim();
  const token = payload?.invitationToken;

  // A cleared payload means this event was already dispatched and re-claimed
  // after the clearing but before the status write — rare, and correctly a
  // no-op rather than an error, since the notification row already exists.
  if (recipient === undefined || recipient === "" || token === undefined) {
    options.logger.warn(
      { eventId: event.id },
      "outbox: provider invitation has no usable payload; already dispatched",
    );
    return { created: 0, duplicate: 0 };
  }

  const tenant = await options.prisma.tenant.findUnique({
    where: { id: event.tenantId },
    select: { id: true, name: true, defaultLanguage: true },
  });

  if (tenant === null) {
    options.logger.warn(
      { eventId: event.id, tenantId: event.tenantId },
      "outbox: organization no longer exists; event discarded",
    );
    return { created: 0, duplicate: 0 };
  }

  // Scoped by tenant like every read (rule 5), even though the foreign key
  // guarantees it. Falls back to the payload's copy if the row has gone: the
  // display name is only the greeting, and discarding the email over a renamed
  // or archived provider would be the wrong trade.
  const provider = await options.prisma.provider.findFirst({
    where: { id: event.aggregateId, tenantId: event.tenantId },
    select: { displayName: true },
  });

  const scheduledAtIso = new Date().toISOString();

  const created = await persistNotification(options.prisma, event.tenantId, {
    type: NotificationTypes.PROVIDER_INVITED,
    channel: NotificationChannels.EMAIL,
    template: "provider-invited",
    // The organization's language, not the provider's `languages[]` — that
    // column says what this person can *work* in, not what they read
    // (phase-9-provider-onboarding §2.8).
    locale: resolveLocale({ tenantLanguage: tenant.defaultLanguage }),
    recipient,
    scheduledAtIso,
    dedupeKey: buildDedupeKey({
      type: NotificationTypes.PROVIDER_INVITED,
      channel: NotificationChannels.EMAIL,
      eventId: event.id,
    }),
    bookingId: null,
    customerId: null,
    // The link the sender cannot rebuild — only the token's hash is stored.
    // Cleared once the email is away.
    payload: {
      organizationName: tenant.name,
      providerName: provider?.displayName ?? payload?.providerName ?? recipient,
      invitedByName: payload?.invitedByName ?? null,
      acceptUrl: buildAppUrl({
        baseUrl: options.appBaseUrl,
        path: `/invitations/${token}`,
        locale: tenant.defaultLanguage,
      }),
      expiresAt: payload?.expiresAt ?? null,
    },
  });

  if (created === undefined) return { created: 0, duplicate: 1 };

  await enqueueIfDue(options, {
    tenantId: event.tenantId,
    notificationId: created.id,
    scheduledAtIso,
  });

  return { created: 1, duplicate: 0 };
}

/**
 * The owner's payment link.
 * docs/phase-9-subscription-and-activation.md §3.2.
 *
 * Unlike a booking event, nothing here is re-read from the world: the payment
 * URL was built at request time and the link is the message. The dedupe key is
 * the event id, so an owner who clicks Subscribe twice legitimately receives
 * two emails — which is right, because the second click usually means the first
 * email did not arrive.
 */
async function dispatchSubscriptionLink(
  event: ClaimedOutboxEvent,
  options: DispatcherOptions,
): Promise<DispatchOneResult> {
  const payload = event.payload as {
    recipientEmail?: string;
    recipientName?: string | null;
    organizationName?: string;
    plan?: string;
    paymentUrl?: string;
  } | null;

  const recipient = payload?.recipientEmail?.trim();

  if (recipient === undefined || recipient === "" || !payload?.paymentUrl) {
    options.logger.warn(
      { eventId: event.id },
      "outbox: subscription event has no usable payload; already dispatched",
    );
    return { created: 0, duplicate: 0 };
  }

  const tenant = await options.prisma.tenant.findUnique({
    where: { id: event.aggregateId },
    select: { id: true, name: true, defaultLanguage: true },
  });

  if (tenant === null) {
    options.logger.warn(
      { eventId: event.id, tenantId: event.aggregateId },
      "outbox: organization no longer exists; event discarded",
    );
    return { created: 0, duplicate: 0 };
  }

  const scheduledAtIso = new Date().toISOString();

  const created = await persistNotification(options.prisma, event.tenantId, {
    type: NotificationTypes.SUBSCRIPTION_LINK,
    channel: NotificationChannels.EMAIL,
    template: "subscription-link",
    locale: resolveLocale({ tenantLanguage: tenant.defaultLanguage }),
    recipient,
    scheduledAtIso,
    dedupeKey: buildDedupeKey({
      type: NotificationTypes.SUBSCRIPTION_LINK,
      channel: NotificationChannels.EMAIL,
      eventId: event.id,
    }),
    bookingId: null,
    customerId: null,
    payload: {
      organizationName: payload.organizationName ?? tenant.name,
      recipientName: payload.recipientName ?? null,
      planName: payload.plan ?? "",
      paymentUrl: payload.paymentUrl,
    },
  });

  if (created === undefined) return { created: 0, duplicate: 1 };

  await enqueueIfDue(options, {
    tenantId: event.tenantId,
    notificationId: created.id,
    scheduledAtIso,
  });

  return { created: 1, duplicate: 0 };
}

/**
 * The two emails Stripe's own lifecycle produces: a trial about to convert, and
 * a renewal that was declined.
 * docs/phase-9-subscription-lifecycle.md §2.1 and §2.3.
 *
 * Unlike the payment link, these originate in the *worker* — a Stripe event
 * arrived, not a request — so the payload carries no recipient. There is only
 * one right one: the organization's owner, who holds `BILLING_MANAGE` and is
 * the person whose card is on file. Looked up here rather than written into the
 * outbox row, because the owner may have changed between the event and the
 * send, and the current owner is the one who can act on it.
 */
async function dispatchBillingNotice(
  event: ClaimedOutboxEvent,
  options: DispatcherOptions,
): Promise<DispatchOneResult> {
  const trialEnding = event.eventType === "TRIAL_ENDING_SOON";

  const payload = event.payload as {
    plan?: string;
    trialEndsAt?: string | null;
    amountDueMinor?: number | null;
    currency?: string | null;
  } | null;

  const tenant = await options.prisma.tenant.findUnique({
    where: { id: event.aggregateId },
    select: {
      id: true,
      name: true,
      defaultLanguage: true,
      memberships: {
        where: { role: "OWNER", status: "ACTIVE" },
        select: { user: { select: { email: true, name: true } } },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });

  if (tenant === null) {
    options.logger.warn(
      { eventId: event.id, tenantId: event.aggregateId },
      "outbox: organization no longer exists; event discarded",
    );
    return { created: 0, duplicate: 0 };
  }

  const owner = tenant.memberships[0]?.user;

  // An organization with no active owner is a real state — the owner's
  // membership can be suspended — and there is nobody to write to. Warned
  // rather than failed: retrying cannot conjure an owner, and a billing email
  // is not worth parking the outbox row over.
  if (owner === undefined) {
    options.logger.warn(
      { eventId: event.id, tenantId: tenant.id },
      "outbox: organization has no active owner to notify",
    );
    return { created: 0, duplicate: 0 };
  }

  const type = trialEnding
    ? NotificationTypes.TRIAL_ENDING_SOON
    : NotificationTypes.SUBSCRIPTION_PAYMENT_FAILED;
  const locale = resolveLocale({ tenantLanguage: tenant.defaultLanguage });
  const scheduledAtIso = new Date().toISOString();

  const created = await persistNotification(options.prisma, event.tenantId, {
    type,
    channel: NotificationChannels.EMAIL,
    template: trialEnding ? "trial-ending" : "payment-failed",
    locale,
    recipient: owner.email,
    scheduledAtIso,
    // Keyed on the event id like every other tenant notification. Stripe sends
    // `trial_will_end` once and `invoice.payment_failed` once per retry, so
    // each genuinely distinct attempt does earn its own email.
    dedupeKey: buildDedupeKey({ type, channel: NotificationChannels.EMAIL, eventId: event.id }),
    bookingId: null,
    customerId: null,
    payload: {
      organizationName: tenant.name,
      recipientName: owner.name,
      planName: payload?.plan ?? "",
      // The screen the email points at is ours, not Stripe's: a portal session
      // expires in minutes and cannot be put in an email
      // (phase-9-customer-portal.md §1.1). The owner signs in and clicks
      // through from there.
      billingUrl: buildAppUrl({
        baseUrl: options.appBaseUrl,
        path: "/dashboard/subscription",
        locale: tenant.defaultLanguage,
      }),
      ...(trialEnding
        ? { trialEndsAt: payload?.trialEndsAt ?? null }
        : {
            amountDueMinor: payload?.amountDueMinor ?? null,
            currency: payload?.currency ?? null,
          }),
    },
  });

  if (created === undefined) return { created: 0, duplicate: 1 };

  await enqueueIfDue(options, {
    tenantId: event.tenantId,
    notificationId: created.id,
    scheduledAtIso,
  });

  return { created: 1, duplicate: 0 };
}

/**
 * The subscription went live. docs/phase-9-owner-onboarding-emails.md §3.
 *
 * The receipt for the whole onboarding path, and the one email the flow was
 * missing: the owner paid on Stripe's hosted page and heard nothing from us
 * again. Stripe sends its own receipt, but that confirms a payment; this
 * confirms that the thing they bought is ready and points them at it.
 *
 * The owner is looked up now rather than carried in the payload, for the same
 * reason `dispatchBillingNotice` does it: the event came from a Stripe webhook,
 * which knows about a subscription and nothing about who should read this.
 */
async function dispatchSubscriptionConfirmed(
  event: ClaimedOutboxEvent,
  options: DispatcherOptions,
): Promise<DispatchOneResult> {
  const payload = event.payload as {
    plan?: string;
    subscriptionId?: string;
    trial?: boolean;
    renewsAt?: string | null;
  } | null;

  // The dedupe key is the subscription, so without one there is nothing to key
  // on and a repeated event would email on every later subscription change.
  // Dropping beats sending an unbounded number of congratulations.
  if (!payload?.subscriptionId) {
    options.logger.warn(
      { eventId: event.id },
      "outbox: subscription confirmation carries no subscription id; discarded",
    );
    return { created: 0, duplicate: 0 };
  }

  const tenant = await options.prisma.tenant.findUnique({
    where: { id: event.aggregateId },
    select: {
      id: true,
      name: true,
      defaultLanguage: true,
      memberships: {
        where: { role: "OWNER", status: "ACTIVE" },
        select: { user: { select: { email: true, name: true } } },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });

  if (tenant === null) {
    options.logger.warn(
      { eventId: event.id, tenantId: event.aggregateId },
      "outbox: organization no longer exists; event discarded",
    );
    return { created: 0, duplicate: 0 };
  }

  const owner = tenant.memberships[0]?.user;

  if (owner === undefined) {
    options.logger.warn(
      { eventId: event.id, tenantId: tenant.id },
      "outbox: organization has no active owner to notify",
    );
    return { created: 0, duplicate: 0 };
  }

  const scheduledAtIso = new Date().toISOString();

  const created = await persistNotification(options.prisma, event.tenantId, {
    type: NotificationTypes.SUBSCRIPTION_CONFIRMED,
    channel: NotificationChannels.EMAIL,
    template: "subscription-confirmed",
    locale: resolveLocale({ tenantLanguage: tenant.defaultLanguage }),
    recipient: owner.email,
    scheduledAtIso,
    // **Keyed on the subscription, not the event** — the one notification in
    // this file that is. `customer.subscription.updated` fires for every later
    // change and each carries a live status, so an event-keyed confirmation
    // would congratulate the owner every time they touched their billing.
    dedupeKey: buildDedupeKey({
      type: NotificationTypes.SUBSCRIPTION_CONFIRMED,
      channel: NotificationChannels.EMAIL,
      subscriptionId: payload.subscriptionId,
    }),
    bookingId: null,
    customerId: null,
    payload: {
      organizationName: tenant.name,
      recipientName: owner.name,
      planName: payload.plan ?? "",
      trial: payload.trial === true,
      renewsAt: payload.renewsAt ?? null,
      // Their dashboard, not Stripe's. The point of this email is that the
      // product is ready, so it points at the product.
      dashboardUrl: buildAppUrl({
        baseUrl: options.appBaseUrl,
        path: "/dashboard",
        locale: tenant.defaultLanguage,
      }),
    },
  });

  if (created === undefined) return { created: 0, duplicate: 1 };

  await enqueueIfDue(options, {
    tenantId: event.tenantId,
    notificationId: created.id,
    scheduledAtIso,
  });

  return { created: 1, duplicate: 0 };
}

/**
 * Insert, or discover it already exists.
 *
 * This is Epic 5's third exit criterion doing its job. The unique index on
 * `(tenant_id, dedupe_key)` decides; P2002 means another pass — a redelivered
 * event, a reclaimed row, a retried job — already committed to sending this
 * exact message, so this one has nothing to do. There is no SELECT first,
 * because between the select and the insert is exactly the window that makes
 * duplicates (rule 14).
 */
async function persistNotification(
  prisma: PrismaClient,
  tenantId: string,
  plan: PersistableNotification,
): Promise<{ id: string } | undefined> {
  try {
    return await prisma.notification.create({
      data: {
        tenantId,
        bookingId: plan.bookingId,
        customerId: plan.customerId,
        type: plan.type,
        channel: plan.channel,
        recipient: plan.recipient,
        template: plan.template,
        locale: plan.locale,
        scheduledAt: new Date(plan.scheduledAtIso),
        dedupeKey: plan.dedupeKey,
        ...(plan.payload === undefined ? {} : { payload: plan.payload as Prisma.InputJsonValue }),
      },
      select: { id: true },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return undefined;
    throw error;
  }
}

/** Prisma's unique-constraint code, duck-typed so it survives bundle boundaries. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

async function enqueueIfDue(
  options: DispatcherOptions,
  args: { tenantId: string; notificationId: string; scheduledAtIso: string },
): Promise<void> {
  const delay = Math.max(0, Date.parse(args.scheduledAtIso) - Date.now());

  if (delay > MAX_QUEUE_LEAD_MS) {
    options.logger.debug(
      { notificationId: args.notificationId, delayMs: delay },
      "outbox: notification scheduled beyond the queue horizon; left for the sweep",
    );
    return;
  }

  await options.queues[QueueNames.NOTIFICATIONS].add(
    NotificationJobs.SEND,
    { tenantId: args.tenantId, notificationId: args.notificationId },
    {
      delay,
      // The notification id is the job's identity, so a re-dispatch of the same
      // row cannot produce a second job even before the sender's own checks.
      jobId: args.notificationId,
    },
  );
}

async function settleFailure(
  event: ClaimedOutboxEvent,
  error: unknown,
  options: DispatcherOptions,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  if (event.attempts >= options.maxAttempts) {
    options.logger.error(
      { eventId: event.id, attempts: event.attempts, err: error },
      "outbox: event exhausted its attempts and was parked",
    );
    await markFailed(options.prisma, {
      tenantId: event.tenantId,
      eventId: event.id,
      error: message,
    });
    return;
  }

  const delayMs = backoffDelayMs({ attempt: event.attempts });

  options.logger.warn(
    { eventId: event.id, attempts: event.attempts, delayMs, err: error },
    "outbox: dispatch failed; scheduled for retry",
  );

  await markForRetry(options.prisma, {
    tenantId: event.tenantId,
    eventId: event.id,
    delayMs,
    error: message,
  });
}

/**
 * The booking as it is *now*, not as it was when the event was written.
 *
 * That distinction is the reason the outbox payload carries ids only. A
 * confirmation event redelivered after the booking was cancelled must not send
 * a confirmation, and the engine can only decide that from current facts.
 *
 * Scoped by tenant, like every repository call (rule 5).
 */
async function loadBookingFacts(
  prisma: PrismaClient,
  args: { tenantId: string; bookingId: string },
): Promise<{ facts: BookingNotificationFacts; tenantSlug: string } | undefined> {
  const booking = await prisma.booking.findFirst({
    where: { id: args.bookingId, tenantId: args.tenantId },
    select: {
      id: true,
      version: true,
      status: true,
      startAt: true,
      customerId: true,
      customerEmailSnapshot: true,
      customer: { select: { preferredLanguage: true } },
      // `slug` is not a planning fact — it builds the "book another time" link
      // on a cancellation — so it travels beside the facts rather than in them.
      tenant: { select: { defaultLanguage: true, slug: true } },
    },
  });

  if (booking === null) return undefined;

  return {
    tenantSlug: booking.tenant.slug,
    facts: {
      bookingId: booking.id,
      bookingVersion: booking.version,
      bookingStatus: booking.status,
      startAtIso: booking.startAt.toISOString(),
      customerId: booking.customerId,
      // The snapshot, not the customer's current address: rule 15, and the
      // reason a confirmation goes where the customer was told it would.
      recipientEmail: booking.customerEmailSnapshot,
      customerLanguage: booking.customer.preferredLanguage,
      tenantLanguage: booking.tenant.defaultLanguage,
    },
  };
}
