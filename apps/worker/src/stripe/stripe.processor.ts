import { Prisma, type PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";
import {
  isLiveSubscription,
  nextTenantStatus,
  planForPrice,
  subscriptionEffect,
  type PlanPrices,
  type SubscribablePlan,
} from "@bam/contracts";

/**
 * Turns recorded Stripe events into tenant state.
 * docs/phase-9-subscription-lifecycle.md, extending
 * docs/phase-9-subscription-and-activation.md §3.3.
 *
 * The webhook records and returns; this decides. That split is what makes the
 * endpoint fast enough not to trip Stripe's retry timer, which is the thing
 * that would otherwise *cause* the duplicate deliveries it has to cope with
 * (phase-9 §2.9).
 *
 * Every effect here is idempotent, because at-least-once delivery guarantees
 * this runs twice for some events. Activation is an update to a known state
 * rather than a toggle, and the subscription row is an upsert whose unique
 * constraint on `tenantId` is what actually enforces "one per tenant"
 * (rule 14).
 *
 * ## What this file does not decide
 *
 * The entitlement rule — which Stripe status means which tenant status — is
 * `subscriptionEffect` in `@bam/contracts`, not an `if` in here. It used to be
 * three fragments spread across activation, mirroring and suspension, each
 * deciding a piece, which is the shape that drifts (rule 8).
 */

export interface StripeProcessorOptions {
  prisma: PrismaClient;
  logger: Logger;
  batchSize: number;
  /** Stripe price ID → plan. The authoritative mapping (§2.4). */
  planPrices: PlanPrices;
  /**
   * How long an event naming a subscription we have never seen keeps retrying
   * before being given up on. See {@link OrphanEventError}.
   */
  orphanTimeoutMs: number;
  /** Lease duration before another replica may recover an abandoned event. */
  staleClaimSeconds?: number;
}

export interface ProcessSummary {
  claimed: number;
  processed: number;
  failed: number;
}

interface ClaimedStripeEvent {
  id: string;
  type: string;
  payload: unknown;
  receivedAt: Date;
  eventCreatedAt: Date;
}

interface ClaimedStripeRow {
  id: string;
  type: string;
  payload_json: unknown;
  received_at: Date;
  event_created_at: Date;
}

interface StripeEventContext extends StripeProcessorOptions {
  eventId: string;
  eventCreatedAt: Date;
}

const DEFAULT_STALE_CLAIM_SECONDS = 300;

async function claimStripeEvents(options: StripeProcessorOptions): Promise<ClaimedStripeEvent[]> {
  const rows = await options.prisma.$queryRaw<ClaimedStripeRow[]>(Prisma.sql`
    UPDATE stripe_events AS event
    SET claimed_at = now(),
        attempts = event.attempts + 1
    FROM (
      SELECT id
      FROM stripe_events
      WHERE processed_at IS NULL
        AND (claimed_at IS NULL OR claimed_at < now() - make_interval(
          secs => ${options.staleClaimSeconds ?? DEFAULT_STALE_CLAIM_SECONDS}
        ))
      ORDER BY event_created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${options.batchSize}
    ) AS claimed
    WHERE event.id = claimed.id
    RETURNING event.id,
              event.type,
              event.payload_json,
              event.received_at,
              event.event_created_at
  `);

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    payload: row.payload_json,
    receivedAt: row.received_at,
    eventCreatedAt: row.event_created_at,
  }));
}

/**
 * An event we cannot attribute *yet*.
 *
 * `customer.subscription.created` carries no `client_reference_id` — that
 * belongs to the checkout session — so the only way to reach a tenant is the
 * subscription ID that `checkout.session.completed` writes. Stripe does not
 * promise an order, so the subscription event can land first and find nothing
 * (docs/phase-9-subscription-lifecycle.md §4).
 *
 * Throwing this leaves the row unprocessed, so the next poll retries it, by
 * which time the sibling event has almost always arrived. The timeout in
 * {@link processOne} is what stops a genuinely foreign subscription — someone
 * else's, or one made by hand in the dashboard — retrying forever.
 */
class OrphanEventError extends Error {
  constructor(subscriptionId: string) {
    super(`No subscription recorded for ${subscriptionId} yet; retrying`);
    this.name = "OrphanEventError";
  }
}

export async function processStripeEventBatch(
  options: StripeProcessorOptions,
): Promise<ProcessSummary> {
  const pending = await claimStripeEvents(options);

  let processed = 0;
  let failed = 0;

  for (const event of pending) {
    try {
      await processOne(event, options);

      await options.prisma.stripeEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date(), claimedAt: null, lastError: null },
      });

      processed += 1;
    } catch (error) {
      failed += 1;

      // The row stays unprocessed and is retried on the next tick. `lastError`
      // is what makes a stuck event diagnosable without reading the logs — it
      // is why the column exists.
      await options.prisma.stripeEvent.update({
        where: { id: event.id },
        data: {
          claimedAt: null,
          lastError: error instanceof Error ? error.message : String(error),
        },
      });

      // An orphan is an expected, self-healing state for a few seconds, so it
      // is not logged as a failure — that would page somebody for the normal
      // case of two events arriving in the wrong order.
      if (error instanceof OrphanEventError) {
        options.logger.debug(
          { eventId: event.id, type: event.type },
          "stripe: event not attributable yet; will retry",
        );
      } else {
        options.logger.error(
          { err: error, eventId: event.id, type: event.type },
          "stripe: processing failed; will retry",
        );
      }
    }
  }

  return { claimed: pending.length, processed, failed };
}

async function processOne(
  event: ClaimedStripeEvent,
  options: StripeProcessorOptions,
): Promise<void> {
  const object = extractObject(event.payload);

  try {
    await dispatch(event.type, object, {
      ...options,
      eventId: event.id,
      eventCreatedAt: event.eventCreatedAt,
    });
  } catch (error) {
    // Give up on an orphan once it is old enough that the sibling event is
    // never coming. Marked processed rather than left failing, so it stops
    // filling the table with permanent retries (§4).
    if (
      error instanceof OrphanEventError &&
      Date.now() - event.receivedAt.getTime() > options.orphanTimeoutMs
    ) {
      options.logger.warn(
        { eventId: event.id, type: event.type },
        "stripe: event names a subscription we never recorded; giving up",
      );
      return;
    }

    throw error;
  }
}

async function dispatch(
  type: string,
  object: Record<string, unknown>,
  options: StripeEventContext,
): Promise<void> {
  switch (type) {
    case "checkout.session.completed":
      return activate(object, options);

    // `created` and `updated` are the same operation. Stripe sends `created`
    // once and `updated` for every change afterwards, and both carry the whole
    // subscription — so treating them differently would be two code paths
    // maintaining one piece of state.
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.resumed":
      return mirrorSubscription(object, options);

    case "customer.subscription.deleted":
    case "customer.subscription.paused":
      return endSubscription(object, options);

    case "customer.subscription.trial_will_end":
      return notifyTrialEnding(object, options);

    case "invoice.payment_failed":
      return notifyPaymentFailed(object, options);

    // The renewal succeeded. `customer.subscription.updated` carries the new
    // period and the status, so there is nothing here to write — but it is
    // named rather than left to the default so the next person does not have
    // to check whether it was forgotten.
    case "invoice.paid":
      options.logger.debug({}, "stripe: invoice paid; subscription events carry the state");
      return;

    case "subscription_schedule.created":
    case "subscription_schedule.updated":
      return mirrorSchedule(object, options);

    case "subscription_schedule.released":
    case "subscription_schedule.canceled":
      return clearSchedule(object, options);

    default:
      // Marked processed by the caller. Stripe sends far more event types than
      // any account subscribes to acting on, and retrying the ones we ignore
      // would fill the table with permanent failures.
      //
      // `charge.refunded` and `refund.updated` land here deliberately: refunds
      // are a Stripe Dashboard action for now (lifecycle record §1), so there
      // is no local state for them to change and inventing one would contradict
      // that decision.
      options.logger.debug({ type }, "stripe: event ignored");
  }
}

/**
 * A completed checkout binds the organization to its Stripe identifiers.
 *
 * `client_reference_id` is the only link back to a tenant: a Payment Link is
 * shared by every customer on that plan, so without it the payment cannot be
 * attributed (§3.2). An event without one is a genuine error rather than
 * something to skip quietly — somebody paid and we cannot tell who.
 *
 * Note what this no longer does: decide the tenant's status. A trial checkout
 * and a paid one produce the same session object, and the session does not
 * carry the subscription's status — so `TRIAL` versus `ACTIVE` is decided by
 * `customer.subscription.*`, which does. This one only makes the subscription
 * findable, which is what lets those events be attributed at all (§4).
 *
 * Nor does it overwrite a subscription this organization already has. See
 * {@link recordDuplicateSubscription} — that overwrite is how three live
 * subscriptions for one tenant stayed invisible.
 */
async function activate(
  object: Record<string, unknown>,
  options: StripeEventContext,
): Promise<void> {
  const tenantId = asString(object["client_reference_id"]);

  if (tenantId === undefined) {
    throw new Error(
      "checkout.session.completed carried no client_reference_id; the payment cannot be attributed to an organization",
    );
  }

  const tenant = await options.prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, status: true },
  });

  if (tenant === null) {
    throw new Error(`checkout.session.completed names tenant ${tenantId}, which does not exist`);
  }

  const customerId = asString(object["customer"]);
  const subscriptionId = asString(object["subscription"]);
  const plan = planFromMetadata(object);

  const identifiers = {
    ...(customerId === undefined ? {} : { stripeCustomerId: customerId }),
    ...(subscriptionId === undefined ? {} : { stripeSubscriptionId: subscriptionId }),
  };

  const existing = await options.prisma.subscription.findUnique({
    where: { tenantId },
    select: { stripeSubscriptionId: true },
  });

  // A second, *different* subscription for one organization — somebody paid
  // twice (docs/phase-9-duplicate-subscription-prevention.md §2.3). The same id
  // arriving again is a redelivery and falls through to the idempotent upsert.
  if (
    subscriptionId !== undefined &&
    existing?.stripeSubscriptionId != null &&
    existing.stripeSubscriptionId !== subscriptionId
  ) {
    await recordDuplicateSubscription(options, {
      tenantId,
      keptSubscriptionId: existing.stripeSubscriptionId,
      duplicateSubscriptionId: subscriptionId,
      duplicateCustomerId: customerId ?? null,
    });

    return;
  }

  await options.prisma.$transaction(async (tx) => {
    await tx.tenant.update({
      where: { id: tenantId },
      data: {
        // The deadline has been met; leaving it set would let the expiry sweep
        // consider a paying customer (phase-9 §2.6). Status is deliberately
        // untouched — see the note above.
        subscribeBy: null,
      },
    });

    await tx.subscription.upsert({
      where: { tenantId },
      create: { tenantId, plan, status: "INCOMPLETE", ...identifiers },
      // Plan is not overwritten on update: by the time a redelivery arrives the
      // subscription events have resolved it properly from the price, and the
      // session's metadata is the weaker source (§2.4).
      update: identifiers,
    });

    // The link has done its job. Recorded rather than deleted so that "this
    // organization already paid through this link" stays answerable — it is the
    // first fact a duplicate-payment investigation needs, and a deleted row
    // makes a burnt link look like one that never existed
    // (docs/phase-9-duplicate-subscription-prevention.md §4).
    //
    // `updateMany` because a tenant may legitimately have no link row: an
    // INTERNAL organization, or one activated before this table existed.
    await tx.subscriptionCheckoutLink.updateMany({
      where: { tenantId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  });

  options.logger.info({ tenantId, subscriptionId }, "stripe: checkout bound to organization");
}

/**
 * One organization, two live Stripe subscriptions. Somebody is being billed
 * twice. docs/phase-9-duplicate-subscription-prevention.md §5.1.
 *
 * ## Why the first one is kept and the second discarded
 *
 * This used to be an unconditional `upsert` whose `update` overwrote
 * `stripeSubscriptionId`, which is how one tenant reached three live
 * subscriptions with nobody noticing: the row pointed at the newest, and every
 * later event for the *older* ones found no row, threw {@link OrphanEventError},
 * retried until the timeout and was then quietly marked processed. They billed
 * monthly with nothing in our database pointing at them.
 *
 * Keeping the first is the conservative choice rather than the correct one —
 * there is no correct one at this point, because both subscriptions are real and
 * both are charging. The first is the one whose trial, plan and period we have
 * already mirrored, so it is the one that leaves the fewest facts wrong while an
 * operator sorts it out.
 *
 * ## Why this does not cancel or refund anything
 *
 * That is a money movement on a live account, made with the whole picture in
 * view — including whether these are two organizations that share a domain, or
 * one that legitimately upgraded (§7). A worker acting alone on a heuristic is
 * how you refund a customer who wanted both.
 *
 * The audit row is written with `SYSTEM` as the actor and both subscription IDs
 * in `afterJson`, so the trail names what an operator has to go and look at.
 */
async function recordDuplicateSubscription(
  options: StripeEventContext,
  input: {
    tenantId: string;
    keptSubscriptionId: string;
    duplicateSubscriptionId: string;
    duplicateCustomerId: string | null;
  },
): Promise<void> {
  const sourceKey = `stripe:${options.eventId}:duplicate-subscription`;

  await options.prisma.auditLog.upsert({
    where: { sourceKey },
    update: {},
    create: {
      sourceKey,
      tenantId: input.tenantId,
      actorType: "SYSTEM",
      action: "billing.duplicate_subscription_detected",
      entityType: "Subscription",
      entityId: input.tenantId,
      // No customer or card data — only Stripe's own identifiers, which are
      // what the operator needs and all rule 6 permits here.
      afterJson: {
        keptSubscriptionId: input.keptSubscriptionId,
        duplicateSubscriptionId: input.duplicateSubscriptionId,
        duplicateCustomerId: input.duplicateCustomerId,
      },
    },
  });

  // `error`, not `warn`: this reaches Sentry, and it should. A customer is
  // paying twice for one thing until somebody acts.
  options.logger.error(
    {
      tenantId: input.tenantId,
      keptSubscriptionId: input.keptSubscriptionId,
      duplicateSubscriptionId: input.duplicateSubscriptionId,
    },
    "stripe: organization has a second live subscription; it is billing and needs cancelling by hand",
  );
}

/**
 * The subscription's own state, which is the source of truth for access.
 * docs/phase-9-subscription-lifecycle.md §3.
 */
async function mirrorSubscription(
  object: Record<string, unknown>,
  options: StripeEventContext,
): Promise<void> {
  const subscriptionId = asString(object["id"]);
  if (subscriptionId === undefined) return;

  const existing = await findByStripeId(subscriptionId, options, object);

  // Throws an unrecognised status rather than storing it (phase-9 §2.7): the
  // predecessor kept Stripe's status as free text, so a value nobody had
  // considered simply sat in the column being wrong.
  const effect = subscriptionEffect(asString(object["status"]) ?? "");

  // What Stripe implies, filtered through what we allow. `nextTenantStatus`
  // refuses to revive a SUSPENDED or CLOSED organization, which is why the
  // tenant's current status has to be read rather than blindly overwritten.
  const tenant = await options.prisma.tenant.findUnique({
    where: { id: existing.tenantId },
    select: { status: true },
  });
  const tenantStatus = nextTenantStatus(tenant?.status ?? "", effect.tenantStatus);
  const trialEndsAt = timestamp(object["trial_end"]);
  const plan = planOf(object, options);

  // Set once and never overwritten — this is the gate that stops a customer
  // who cancels and resubscribes collecting a second free month (§5). A
  // redelivered event must not refresh it, which is why it is conditional
  // rather than "set it whenever trialing".
  const startsTrial = effect.status === "TRIALING" && existing.trialUsedAt === null;

  const applied = await options.prisma.$transaction(async (tx) => {
    const updated = await tx.subscription.updateMany({
      where: {
        stripeSubscriptionId: subscriptionId,
        ...newerStateEvent(options),
      },
      data: {
        status: effect.status,
        cancelAtPeriodEnd: isEnding(object),
        ...periodEndOf(object),
        ...(plan === undefined ? {} : { plan }),
        ...priceOf(object),
        ...(trialEndsAt === undefined ? {} : { trialEndsAt }),
        ...(startsTrial ? { trialUsedAt: new Date() } : {}),
        // A schedule that has done its work leaves the subscription carrying
        // the plan it was scheduled to reach. Clearing here as well as on
        // `released` matters because Stripe releases a completed schedule
        // silently in some flows.
        ...(plan !== undefined && plan === existing.pendingPlan
          ? { stripeScheduleId: null, pendingPlan: null, pendingPlanStartsAt: null }
          : {}),
        lastStripeStateEventAt: options.eventCreatedAt,
        lastStripeStateEventId: options.eventId,
      },
    });

    if (updated.count === 0) return false;

    if (tenantStatus !== null) {
      await tx.tenant.update({
        where: { id: existing.tenantId },
        data: { status: tenantStatus, ...(startsTrial ? { subscribeBy: null } : {}) },
      });
    }

    return true;
  });

  if (!applied) {
    options.logger.info(
      { eventId: options.eventId, subscriptionId },
      "stripe: stale subscription event ignored",
    );
    return;
  }

  options.logger.info(
    { tenantId: existing.tenantId, status: effect.status, tenantStatus },
    "stripe: subscription mirrored",
  );

  // The receipt for onboarding. Emitted on the *transition* into a live status
  // rather than whenever one is seen, because `customer.subscription.updated`
  // fires for every later change and each one carries a live status
  // (docs/phase-9-owner-onboarding-emails.md §3).
  //
  // Two guards, not one: this test keeps the outbox clean, and the dedupe key
  // on the subscription id — not the event id, unlike every other tenant
  // notification — is what actually guarantees one email. The read-then-write
  // here has a window in it, and the unique index is what closes it (rule 14).
  if (isLiveSubscription(effect.status) && !isLiveSubscription(existing.status)) {
    await requestNotification(options, {
      tenantId: existing.tenantId,
      eventType: "SUBSCRIPTION_CONFIRMED",
      payload: {
        subscriptionId,
        plan: plan ?? existing.plan,
        trial: effect.status === "TRIALING",
        // The date the money moves: the trial's end while trialing, the period
        // end once paying. Null when Stripe named neither, which drops the line
        // rather than inventing a date the customer would be held to.
        renewsAt:
          (effect.status === "TRIALING"
            ? (trialEndsAt ?? existing.trialEndsAt)
            : timestamp(object["current_period_end"])
          )?.toISOString() ?? null,
      },
    });
  }
}

/**
 * A cancelled or paused subscription suspends the organization. Never closes it.
 *
 * phase-9 §2.6: a former customer's data carries obligations — invoices,
 * bookings taken, their customers' personal data. Closure is reserved for
 * prospects who never subscribed at all, and conflating the two would discard
 * records somebody is required to keep.
 */
async function endSubscription(
  object: Record<string, unknown>,
  options: StripeEventContext,
): Promise<void> {
  const subscriptionId = asString(object["id"]);
  if (subscriptionId === undefined) return;

  const existing = await findByStripeId(subscriptionId, options, object);

  const applied = await options.prisma.$transaction(async (tx) => {
    const updated = await tx.subscription.updateMany({
      where: {
        stripeSubscriptionId: subscriptionId,
        ...newerStateEvent(options),
      },
      data: {
        status: "CANCELED",
        // Nothing is scheduled on a subscription that has ended.
        stripeScheduleId: null,
        pendingPlan: null,
        pendingPlanStartsAt: null,
        lastStripeStateEventAt: options.eventCreatedAt,
        lastStripeStateEventId: options.eventId,
      },
    });

    if (updated.count === 0) return false;

    await tx.tenant.update({
      where: { id: existing.tenantId },
      data: { status: "SUSPENDED" },
    });

    return true;
  });

  if (!applied) {
    options.logger.info(
      { eventId: options.eventId, subscriptionId },
      "stripe: stale subscription-ending event ignored",
    );
    return;
  }

  options.logger.info({ tenantId: existing.tenantId }, "stripe: organization suspended");
}

/**
 * A scheduled plan change — in practice a downgrade, which the portal is
 * configured to defer to the end of the period (guide §4, record §2.4).
 *
 * The subscription itself does not change until renewal, so without this the
 * owner sees the plan they are leaving and no sign that they left it. Support
 * then fields "why am I still on Professional".
 */
async function mirrorSchedule(
  object: Record<string, unknown>,
  options: StripeEventContext,
): Promise<void> {
  const scheduleId = asString(object["id"]);
  const subscriptionId = asString(object["subscription"]);

  if (scheduleId === undefined || subscriptionId === undefined) return;

  const existing = await findByStripeId(subscriptionId, options);
  const upcoming = upcomingPhase(object, options);

  // A schedule whose remaining phase we cannot read is not an error — it may
  // simply have no phase left, which is what a schedule about to be released
  // looks like. Recording the id still lets `released` find it.
  const updated = await options.prisma.subscription.updateMany({
    where: {
      stripeSubscriptionId: subscriptionId,
      ...newerScheduleEvent(options),
    },
    data: {
      stripeScheduleId: scheduleId,
      pendingPlan: upcoming?.plan ?? null,
      pendingPlanStartsAt: upcoming?.startsAt ?? null,
      lastStripeScheduleEventAt: options.eventCreatedAt,
      lastStripeScheduleEventId: options.eventId,
    },
  });

  if (updated.count === 0) {
    options.logger.info(
      { eventId: options.eventId, subscriptionId },
      "stripe: stale schedule event ignored",
    );
    return;
  }

  options.logger.info(
    { tenantId: existing.tenantId, pendingPlan: upcoming?.plan ?? null },
    "stripe: schedule mirrored",
  );
}

/** The schedule was released or cancelled: nothing is pending any more. */
async function clearSchedule(
  object: Record<string, unknown>,
  options: StripeEventContext,
): Promise<void> {
  const subscriptionId = asString(object["subscription"]);
  if (subscriptionId === undefined) return;

  const existing = await findByStripeId(subscriptionId, options);

  const updated = await options.prisma.subscription.updateMany({
    where: {
      stripeSubscriptionId: subscriptionId,
      ...newerScheduleEvent(options),
    },
    data: {
      stripeScheduleId: null,
      pendingPlan: null,
      pendingPlanStartsAt: null,
      lastStripeScheduleEventAt: options.eventCreatedAt,
      lastStripeScheduleEventId: options.eventId,
    },
  });

  if (updated.count === 0) {
    options.logger.info(
      { eventId: options.eventId, subscriptionId },
      "stripe: stale schedule-clearing event ignored",
    );
    return;
  }

  options.logger.info({ tenantId: existing.tenantId }, "stripe: schedule cleared");
}

/**
 * Stripe sends this three days before a trial ends (immediately, for a trial
 * shorter than that). The card is already on file, so this is a courtesy rather
 * than a call to action — but a charge nobody expected is the commonest reason
 * a new customer disputes one.
 */
async function notifyTrialEnding(
  object: Record<string, unknown>,
  options: StripeEventContext,
): Promise<void> {
  const subscriptionId = asString(object["id"]);
  if (subscriptionId === undefined) return;

  const existing = await findByStripeId(subscriptionId, options, object);

  await requestNotification(options, {
    tenantId: existing.tenantId,
    eventType: "TRIAL_ENDING_SOON",
    payload: {
      plan: existing.plan,
      trialEndsAt: (timestamp(object["trial_end"]) ?? existing.trialEndsAt)?.toISOString() ?? null,
    },
  });
}

/**
 * A renewal failed. Access continues — Stripe is still retrying, and its
 * dunning is the grace period (§2.3) — so this email exists to get the card
 * fixed before the retries run out and the organization is suspended.
 */
async function notifyPaymentFailed(
  object: Record<string, unknown>,
  options: StripeEventContext,
): Promise<void> {
  const subscriptionId = asString(object["subscription"]);
  if (subscriptionId === undefined) return;

  const existing = await findByStripeId(subscriptionId, options);

  await requestNotification(options, {
    tenantId: existing.tenantId,
    eventType: "SUBSCRIPTION_PAYMENT_FAILED",
    payload: {
      plan: existing.plan,
      // Minor units, as everywhere else in this codebase (rule 15's currency
      // pairing). Null rather than zero when Stripe omits it.
      amountDueMinor: typeof object["amount_due"] === "number" ? object["amount_due"] : null,
      currency: asString(object["currency"])?.toUpperCase() ?? null,
    },
  });
}

/**
 * Ask for an email; do not send one.
 *
 * The same rule as everywhere else (tech-impl §12): the worker writes an outbox
 * row and the dispatcher owns delivery, so a Resend outage retries rather than
 * marking a Stripe event failed and replaying the whole thing.
 */
async function requestNotification(
  options: StripeEventContext,
  input: { tenantId: string; eventType: string; payload: Record<string, unknown> },
): Promise<void> {
  await options.prisma.outboxEvent.upsert({
    where: { id: `stripe:${options.eventId}:${input.eventType}` },
    update: {},
    create: {
      id: `stripe:${options.eventId}:${input.eventType}`,
      tenantId: input.tenantId,
      eventType: input.eventType,
      aggregateType: "Tenant",
      aggregateId: input.tenantId,
      payload: input.payload as never,
    },
  });
}

/**
 * Find the subscription an event is about, or ask to be retried.
 *
 * The retry rather than a warning is §4's whole point: an event that arrives
 * before its sibling used to be dropped silently, which is the guide's test #15
 * failing in the least visible way possible.
 */
async function findByStripeId(
  subscriptionId: string,
  options: StripeProcessorOptions,
  /**
   * The event's own object, so a subscription we have not bound yet can still
   * be attributed. Links created since
   * docs/phase-9-duplicate-subscription-prevention.md §4.1 carry
   * `subscription_data.metadata.tenantId`, which propagates onto the
   * subscription — so `customer.subscription.created` arriving before its
   * checkout session is no longer unattributable, and the ordering race in
   * §4 of the lifecycle record stops being routine.
   *
   * Omitted by callers whose event carries no such metadata.
   */
  object?: Record<string, unknown>,
) {
  const select = {
    tenantId: true,
    plan: true,
    // Read so `mirrorSubscription` can tell a transition into a live status
    // from the many later events that merely report one.
    status: true,
    trialUsedAt: true,
    trialEndsAt: true,
    pendingPlan: true,
  } as const;

  const existing = await options.prisma.subscription.findUnique({
    where: { stripeSubscriptionId: subscriptionId },
    select,
  });

  if (existing !== null) return existing;

  // Not bound yet. Bind it now if the subscription says whose it is, rather
  // than throwing and waiting for a sibling event that may already have been
  // processed.
  const tenantId =
    object === undefined ? undefined : asString(asRecord(object["metadata"])?.["tenantId"]);

  if (tenantId !== undefined) {
    const claimed = await claimByTenantMetadata(tenantId, subscriptionId, options, select);

    if (claimed !== null) return claimed;
  }

  // Subscriptions predating §4.1 carry no metadata, and a genuinely foreign one
  // never will. Both still need the retry-then-give-up behaviour.
  throw new OrphanEventError(subscriptionId);
}

/**
 * Attach a subscription to the tenant its metadata names.
 *
 * Deliberately refuses to steal one: if that tenant's row already points at a
 * *different* Stripe subscription, this is the duplicate-payment case, not a
 * late binding. Overwriting is precisely the bug §2.3 records, so it is left to
 * `activate()`'s conflict path rather than done quietly here.
 */
async function claimByTenantMetadata(
  tenantId: string,
  subscriptionId: string,
  options: StripeProcessorOptions,
  select: {
    tenantId: true;
    plan: true;
    status: true;
    trialUsedAt: true;
    trialEndsAt: true;
    pendingPlan: true;
  },
) {
  const row = await options.prisma.subscription.findUnique({
    where: { tenantId },
    select: { ...select, stripeSubscriptionId: true },
  });

  if (row !== null && row.stripeSubscriptionId !== null) return null;

  if (row === null) {
    // No row at all: the subscription event beat its checkout session here.
    // Plan is left to be resolved from the price by the caller.
    await options.prisma.subscription.create({
      data: {
        tenantId,
        plan: "STARTER",
        status: "INCOMPLETE",
        stripeSubscriptionId: subscriptionId,
      },
    });
  } else {
    await options.prisma.subscription.update({
      where: { tenantId },
      data: { stripeSubscriptionId: subscriptionId },
    });
  }

  options.logger.info(
    { tenantId, subscriptionId },
    "stripe: subscription attributed by its own metadata",
  );

  return options.prisma.subscription.findUniqueOrThrow({
    where: { stripeSubscriptionId: subscriptionId },
    select,
  });
}

/** Stripe wraps the interesting part in `data.object`. */
function extractObject(payload: unknown): Record<string, unknown> {
  const data = (payload as { data?: { object?: unknown } } | null)?.data?.object;

  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

/** Conditional-update predicate implementing (created_at, event_id) ordering. */
function newerStateEvent(options: StripeEventContext): Prisma.SubscriptionWhereInput {
  return {
    OR: [
      { lastStripeStateEventAt: null },
      { lastStripeStateEventAt: { lt: options.eventCreatedAt } },
      {
        lastStripeStateEventAt: options.eventCreatedAt,
        OR: [{ lastStripeStateEventId: null }, { lastStripeStateEventId: { lt: options.eventId } }],
      },
    ],
  };
}

function newerScheduleEvent(options: StripeEventContext): Prisma.SubscriptionWhereInput {
  return {
    OR: [
      { lastStripeScheduleEventAt: null },
      { lastStripeScheduleEventAt: { lt: options.eventCreatedAt } },
      {
        lastStripeScheduleEventAt: options.eventCreatedAt,
        OR: [
          { lastStripeScheduleEventId: null },
          { lastStripeScheduleEventId: { lt: options.eventId } },
        ],
      },
    ],
  };
}

/**
 * Which plan was bought, at checkout.
 *
 * A Payment Link carries it in metadata, set once when the link is created in
 * the Stripe dashboard. Falling back to STARTER rather than throwing is
 * deliberate: a customer who has paid must end up active, and being on the
 * cheaper plan is a billing correction rather than a locked-out customer.
 *
 * Only the checkout session still reads metadata; everything else goes through
 * the price ID (§2.4), and the subscription events correct this value within
 * seconds anyway.
 */
function planFromMetadata(object: Record<string, unknown>): SubscribablePlan {
  return metadataPlan(object) === "PROFESSIONAL" ? "PROFESSIONAL" : "STARTER";
}

/**
 * Which plan a subscription is on, and nothing when the event does not say.
 *
 * Resolved from the price ID through config, with metadata as the fallback
 * (§2.4). Leaving the column alone when neither answers is the opposite of
 * `planFromMetadata`'s fall back to STARTER, and both are right for their
 * position: at activation there is no plan yet and the customer has paid, so
 * any answer beats a locked-out customer; here there is already a plan that was
 * correct a moment ago, and guessing would silently downgrade a customer who
 * had just upgraded.
 */
function planOf(
  object: Record<string, unknown>,
  options: StripeProcessorOptions,
): SubscribablePlan | undefined {
  const price = firstPrice(object);

  return (
    planForPrice(asString(price?.["id"]), options.planPrices) ??
    asPlan(metadataPlan(object)) ??
    asPlan(metadataPlan(price))
  );
}

/** The subscription's current price, stored so a wrong plan is diagnosable. */
function priceOf(object: Record<string, unknown>): { stripePriceId?: string } {
  const priceId = asString(firstPrice(object)?.["id"]);

  return priceId === undefined ? {} : { stripePriceId: priceId };
}

/**
 * The phase that has not started yet — what the subscription becomes.
 *
 * A schedule's phases are chronological and the first one is current, so the
 * first phase starting in the future is the pending change. Its price is a bare
 * ID string with no metadata on it, which is exactly why plan resolution had to
 * stop depending on metadata (§2.4).
 */
function upcomingPhase(
  object: Record<string, unknown>,
  options: StripeProcessorOptions,
): { plan: SubscribablePlan; startsAt: Date } | undefined {
  const phases = object["phases"];
  if (!Array.isArray(phases)) return undefined;

  const now = Date.now();

  for (const entry of phases as Record<string, unknown>[]) {
    const startsAt = timestamp(entry["start_date"]);
    if (startsAt === undefined || startsAt.getTime() <= now) continue;

    const items = entry["items"];
    const first = Array.isArray(items)
      ? (items[0] as Record<string, unknown> | undefined)
      : undefined;

    // On a schedule phase `price` is the ID itself, not an object — the one
    // place in the API where that differs from a subscription item.
    const priceId = asString(first?.["price"]) ?? asString(asRecord(first?.["price"])?.["id"]);
    const plan = planForPrice(priceId, options.planPrices);

    if (plan !== undefined) return { plan, startsAt };
  }

  return undefined;
}

/**
 * Whether this subscription is scheduled to stop.
 *
 * Two fields say so, and which one Stripe uses depends on the account's billing
 * mode: **classic** sets `cancel_at_period_end`, **flexible** — the newer
 * default — leaves that false and sets `cancel_at` to a timestamp instead. A
 * cancellation made from the customer portal is exactly where the difference
 * shows up (docs/phase-9-customer-portal.md §3.1).
 *
 * Reading only the boolean fails silently and completely: the owner cancels,
 * Stripe agrees, and our screen goes on saying "renews on" until the day the
 * organization is suspended without warning. No error, no retry, no row that
 * looks wrong.
 */
function isEnding(object: Record<string, unknown>): boolean {
  return object["cancel_at_period_end"] === true || typeof object["cancel_at"] === "number";
}

function metadataPlan(object: Record<string, unknown> | undefined): string | undefined {
  const metadata = asRecord(object?.["metadata"]);

  return metadata === undefined ? undefined : asString(metadata["plan"]);
}

/** `items.data[0].price` — a subscription we sell has exactly one item. */
function firstPrice(object: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = asRecord(object["items"])?.["data"];
  const first = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;

  return asRecord(first?.["price"]);
}

function periodEndOf(object: Record<string, unknown>): { currentPeriodEnd?: Date } {
  const end = timestamp(object["current_period_end"]);

  return end === undefined ? {} : { currentPeriodEnd: end };
}

function timestamp(value: unknown): Date | undefined {
  return typeof value === "number" ? new Date(value * 1_000) : undefined;
}

function asPlan(value: string | undefined): SubscribablePlan | undefined {
  return value === "STARTER" || value === "PROFESSIONAL" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
