import type { BookingStatus, PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";
import { deriveEventId } from "@bam/google-calendar";

import { CalendarJobs, QueueNames, calendarJobId, type QueueRegistry } from "../queues.js";

/**
 * The second leg of a booking outbox event: what the calendars should now say.
 * docs/phase-6-google-calendar-part-1.md §2.2, §2.4.
 *
 * ## Why this runs inside `dispatchOne` rather than polling for itself
 *
 * **The outbox is single-consumer.** `outbox_events` has one `status` column and
 * `markProcessed` clears the payload, so a second poller over the same rows is
 * not expressible without a schema change. The calendar leg therefore shares the
 * notification dispatcher's claim: one claim, two legs.
 *
 * It runs *after* the notification work, deliberately. A notification is what the
 * customer is owed; a calendar entry is a convenience for the provider. If this
 * throws, the outbox row is retried and the notifications are skipped as
 * duplicates on the way back through — so the ordering costs nothing and means a
 * Google-shaped problem can never delay a confirmation email.
 *
 * ## Why the desired state comes from the booking, not from the event type
 *
 * This is the subtle one, and getting it wrong resurrects cancelled
 * appointments in people's diaries.
 *
 * A redelivered `BOOKING_CONFIRMED` for a booking that has since been cancelled
 * would, read literally, ask for the event to be present. So the event type is
 * treated as *"this booking's calendar state may have changed"* and the booking's
 * **current** status decides what that state is — exactly the reasoning
 * `loadBookingFacts` applies to notifications one function up.
 *
 * The `desiredVersion` guard then closes the remaining interleaving: two
 * dispatchers can read the booking at different versions, and the one holding the
 * older reading must not overwrite the newer. The comparison lives *in* the
 * update statement rather than in a branch above it, so PostgreSQL decides
 * (rule 14).
 */

export interface CalendarLegOptions {
  prisma: PrismaClient;
  queues: QueueRegistry;
  logger: Logger;
}

export interface CalendarLegResult {
  /** Rows created or advanced, and therefore jobs enqueued. */
  queued: number;
}

const NOTHING: CalendarLegResult = { queued: 0 };

/**
 * What a booking in this state should look like in a calendar.
 *
 * `null` means "no opinion, leave whatever is there alone":
 *
 *   - **PENDING** — record §3.8. An appointment nobody has accepted appearing in
 *     a provider's diary is worse than its absence, and the slot is still held by
 *     us so nothing is oversold.
 *   - **EXPIRED** — a PENDING booking that timed out. It was never in a calendar,
 *     because PENDING never puts one there.
 *
 * `COMPLETED` and `NO_SHOW` map to PRESENT rather than to nothing: the
 * appointment happened (or was supposed to), and removing it from somebody's
 * diary afterwards would be rewriting their history.
 */
function desiredStateFor(status: BookingStatus): "PRESENT" | "CANCELLED" | null {
  switch (status) {
    case "CONFIRMED":
    case "COMPLETED":
    case "NO_SHOW":
      return "PRESENT";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return null;
  }
}

export async function dispatchCalendarLeg(
  event: { tenantId: string; aggregateType: string; aggregateId: string },
  options: CalendarLegOptions,
): Promise<CalendarLegResult> {
  if (event.aggregateType !== "Booking") return NOTHING;

  const booking = await options.prisma.booking.findFirst({
    where: { id: event.aggregateId, tenantId: event.tenantId },
    select: { id: true, providerId: true, version: true, status: true },
  });

  // Gone. The event mapping rows cascade with it, so there is nothing to say.
  if (booking === null) return NOTHING;

  const desiredState = desiredStateFor(booking.status);
  if (desiredState === null) return NOTHING;

  // **The one query that runs when nobody has connected a calendar**, which is
  // every tenant today and most tenants forever. Indexed on
  // `(tenant_id, provider_id, active)`, returns nothing, costs nothing — which is
  // what lets this leg sit in the dispatcher's hot path without an "is the
  // feature on" flag to forget to check.
  const mappings = await options.prisma.calendarMapping.findMany({
    where: {
      tenantId: event.tenantId,
      providerId: booking.providerId,
      active: true,
      writeBookings: true,
    },
    select: { id: true },
  });

  if (mappings.length === 0) return NOTHING;

  let queued = 0;

  for (const mapping of mappings) {
    const advanced = await recordDesire(options.prisma, {
      tenantId: event.tenantId,
      bookingId: booking.id,
      calendarMappingId: mapping.id,
      desiredState,
      desiredVersion: booking.version,
    });

    if (advanced === null) continue;

    queued += 1;

    await options.queues[QueueNames.CALENDAR_SYNC].add(
      CalendarJobs.SYNC_EVENT,
      { tenantId: event.tenantId, eventMappingId: advanced.id },
      {
        // Row, desire and attempt together — see `calendarJobId`. A re-dispatch
        // of the same desire collapses into one job; a *new* desire is allowed
        // its own, which keying on the row alone would have silently refused.
        jobId: calendarJobId(advanced),
      },
    );
  }

  return { queued };
}

/**
 * Write what we want, unless somebody already wants something newer.
 *
 * Returns the row when the desire moved, `null` when it did not — which is how
 * the caller knows whether a job is worth enqueueing. `attempts` is `0` on both
 * paths: a create starts there, and the guarded update resets it, because what
 * failed before is not what is being asked for now.
 *
 * Two shapes, and the asymmetry is deliberate:
 *
 *   - **PRESENT** inserts if the row is absent. A newly confirmed booking has no
 *     mapping row yet and this is what creates it.
 *   - **CANCELLED** only ever *updates*. No row means nothing was ever written to
 *     a calendar, so there is nothing to grey out — inserting one would queue a
 *     job whose only job is to discover it has no work.
 */
async function recordDesire(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    bookingId: string;
    calendarMappingId: string;
    desiredState: "PRESENT" | "CANCELLED";
    desiredVersion: number;
  },
): Promise<{ id: string; desiredVersion: number; attempts: number } | null> {
  const now = new Date();
  const settled = (id: string) => ({ id, desiredVersion: input.desiredVersion, attempts: 0 });

  if (input.desiredState === "PRESENT") {
    try {
      const created = await prisma.calendarEventMapping.create({
        data: {
          tenantId: input.tenantId,
          bookingId: input.bookingId,
          calendarMappingId: input.calendarMappingId,
          // Computable before the row exists, which is what lets the column be
          // NOT NULL and what makes the create idempotent at Google's end (§2.3).
          externalEventId: deriveEventId(input.bookingId, input.calendarMappingId),
          desiredState: "PRESENT",
          desiredVersion: input.desiredVersion,
          syncStatus: "PENDING",
        },
        select: { id: true },
      });

      return settled(created.id);
    } catch (error) {
      // The unique index on `(booking_id, calendar_mapping_id)` decides that a
      // row already exists — never a SELECT first, because between the select
      // and the insert is exactly the window that makes duplicates (rule 14).
      if (!isUniqueViolation(error)) throw error;
    }
  }

  // **The guard §2.4 exists for.** A redelivered event carrying an older reading
  // of the booking must not overwrite a newer one — which is what stops a stale
  // `BOOKING_RESCHEDULED` resurrecting the event of a booking since cancelled.
  const { count } = await prisma.calendarEventMapping.updateMany({
    where: {
      tenantId: input.tenantId,
      bookingId: input.bookingId,
      calendarMappingId: input.calendarMappingId,
      desiredVersion: { lt: input.desiredVersion },
    },
    data: {
      desiredState: input.desiredState,
      desiredVersion: input.desiredVersion,
      // Back to work, whatever it was doing. A row parked FAILED against an old
      // version deserves a fresh budget for a new one: the thing that failed is
      // not the thing being asked for now.
      syncStatus: "PENDING",
      attempts: 0,
      nextAttemptAt: now,
      claimedAt: null,
      lastError: null,
    },
  });

  if (count === 0) return null;

  const row = await prisma.calendarEventMapping.findUnique({
    where: {
      bookingId_calendarMappingId: {
        bookingId: input.bookingId,
        calendarMappingId: input.calendarMappingId,
      },
    },
    select: { id: true },
  });

  return row === null ? null : settled(row.id);
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
