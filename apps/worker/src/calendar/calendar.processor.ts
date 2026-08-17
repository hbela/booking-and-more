import type { PrismaClient } from "@bam/db";
import type { Logger } from "@bam/observability";
import {
  buildBookingEvent,
  classifyUnknown,
  GoogleFailureKinds,
  googleBackoffMs,
  type GoogleCalendarClient,
  type GoogleEventResult,
  type GoogleOAuthClient,
} from "@bam/google-calendar";

import type { QueueRegistry } from "../queues.js";
import { notifyCalendarDisconnected } from "./calendar.disconnected.js";
import { CalendarGrantError, resolveAccessToken } from "./calendar.tokens.js";

/**
 * Turns one `calendar_event_mappings` row into the state Google should be in.
 * tech-impl §25.5, docs/phase-6-google-calendar-part-1.md §2.3, §2.4.
 *
 * The row is the durable commitment; this is the attempt. Everything about
 * *whether to try again* lives in `@bam/google-calendar`'s classifier (§26.3) —
 * this module performs the I/O and records what happened, the same split
 * `notification.sender.ts` makes for email.
 *
 * ## The promise this file must not break
 *
 * **A confirmed booking stays confirmed when sync fails** (PRD §9.10, §25.6).
 * Nothing here writes to `bookings`, ever, on any path. The database is the
 * record of appointments and Google holds a mirror; a mirror that fails to
 * update has no opinion about the thing it mirrors. The test file asserts
 * `booking.status` after every failure path rather than trusting this paragraph.
 *
 * ## Claiming, and the version that goes with it
 *
 * A job can arrive twice — BullMQ redelivers, and the sweep picks up anything
 * still PENDING — so the row is claimed with a conditional update and the loser
 * sees zero rows (rule 14, same shape as the notification and outbox claims).
 *
 * The subtler half is *which desire* was attempted. `desiredVersion` is read at
 * claim time and carried through, and the success write is conditional on it not
 * having moved. A reschedule landing while we were talking to Google therefore
 * leaves the row PENDING at the newer version rather than SYNCED at the older
 * one — which is the difference between a diary that is briefly behind and one
 * that is permanently wrong.
 */

export const CalendarOutcomes = {
  /** Google now says what we wanted it to say. */
  SYNCED: "SYNCED",
  /** Someone else holds the row, or it is already done. Not an error. */
  NOT_CLAIMED: "NOT_CLAIMED",
  /** The desire changed while we were working. Left PENDING at the new version. */
  SUPERSEDED: "SUPERSEDED",
  /**
   * Terminal, parked for a human.
   *
   * There is deliberately no `RETRY` member: a transient failure **throws**,
   * because throwing is what applies BullMQ's own backoff on top of the row's
   * `nextAttemptAt`. An outcome returned normally always means the job is done
   * with, one way or another.
   */
  FAILED: "FAILED",
  /** Nothing to do: no calendar to write to, or a grant that needs re-consent. */
  SKIPPED: "SKIPPED",
} as const;

export type CalendarOutcome = (typeof CalendarOutcomes)[keyof typeof CalendarOutcomes];

export interface CalendarProcessorOptions {
  prisma: PrismaClient;
  calendar: GoogleCalendarClient;
  oauth: GoogleOAuthClient;
  encryptionKey: Buffer;
  logger: Logger;
  maxAttempts: number;
  /**
   * `APP_BASE_URL`, for the staff link in the event description and for the
   * reconnection link in the disconnection email.
   */
  appBaseUrl: string;
  /**
   * Where the disconnection email is queued.
   *
   * **This is the one thing the API deliberately does not do.** Its own
   * `NEEDS_RECONNECT` path (`translateGoogleFailure`) marks the integration and
   * says nothing, because a person is sitting in front of the screen and will
   * read the banner a moment later. The worker's failure is the invisible one —
   * it happens hours after a booking, with nobody watching — which is exactly
   * why it is the half that earns an email.
   */
  queues: QueueRegistry;
  /** Injectable for tests; `googleBackoffMs`'s jitter is otherwise unassertable. */
  random?: (() => number) | undefined;
}

export async function syncCalendarEvent(
  args: { tenantId: string; eventMappingId: string },
  options: CalendarProcessorOptions,
): Promise<CalendarOutcome> {
  const now = new Date();

  const claimed = await claim(options.prisma, args, now);
  if (claimed === null) return CalendarOutcomes.NOT_CLAIMED;

  const row = await options.prisma.calendarEventMapping.findFirst({
    where: { id: args.eventMappingId, tenantId: args.tenantId },
    include: {
      calendarMapping: { include: { integration: true } },
      booking: {
        include: {
          service: { select: { name: true } },
          location: { select: { name: true, addressLine1: true, city: true } },
          provider: { select: { timezone: true } },
        },
      },
    },
  });

  if (row === null) return CalendarOutcomes.NOT_CLAIMED;

  const mapping = row.calendarMapping;
  const integration = mapping.integration;

  // The calendar stopped being one we write to — the provider re-pointed their
  // diary, or disconnected. Parked rather than retried: no amount of waiting
  // brings a deselected calendar back, and `POST /sync` revives these if it does.
  if (!mapping.active || !mapping.writeBookings) {
    await park(options.prisma, row.id, "calendar is no longer selected");
    return CalendarOutcomes.SKIPPED;
  }

  if (integration.status !== "ACTIVE") {
    // Waiting for a human. Released **without counting the attempt** — an
    // attempt that never reached Google is not an attempt, and burning the
    // budget here would park every pending row before the provider had a chance
    // to reconnect, turning "resume" into "start again".
    await release(options.prisma, row.id, waitForHuman(now), { countsAsAttempt: false });
    return CalendarOutcomes.SKIPPED;
  }

  const attemptedVersion = claimed.desiredVersion;
  const failureContext = {
    tenantId: args.tenantId,
    rowId: row.id,
    integrationId: integration.id,
    attempts: row.attempts,
  };

  let accessToken: string;
  try {
    accessToken = await resolveAccessToken(integration, now, {
      prisma: options.prisma,
      oauth: options.oauth,
      encryptionKey: options.encryptionKey,
    });
  } catch (error) {
    if (error instanceof CalendarGrantError) {
      // `resolveAccessToken` has already marked the integration. Same treatment
      // as the branch above, for the same reason.
      await release(options.prisma, row.id, waitForHuman(now), { countsAsAttempt: false });

      // The one path that tells a human. Deduped to once per UTC day, which
      // matters here more than anywhere: a dead grant fails every queued row,
      // so without the key this would send one email per booking.
      await notifyCalendarDisconnected(
        {
          tenantId: args.tenantId,
          integrationId: integration.id,
          reason: error.reason,
          now,
        },
        {
          prisma: options.prisma,
          queues: options.queues,
          logger: options.logger,
          appBaseUrl: options.appBaseUrl,
        },
      );

      return CalendarOutcomes.SKIPPED;
    }

    return failure(error, failureContext, options);
  }

  let result: GoogleEventResult;
  try {
    result = await perform({ row, mapping, accessToken }, options);
  } catch (error) {
    return failure(error, failureContext, options);
  }

  return succeed({ rowId: row.id, attemptedVersion, result }, options);
}

// ---------------------------------------------------------------------------
// The Google calls
// ---------------------------------------------------------------------------

/** Exactly what {@link perform} reads. Structural, so a Prisma row satisfies it. */
interface SyncableRow {
  id: string;
  externalEventId: string;
  externalEventEtag: string | null;
  desiredState: "PRESENT" | "CANCELLED";
  syncedVersion: number | null;
  attempts: number;
  booking: {
    id: string;
    reference: string;
    startAt: Date;
    endAt: Date;
    customerNameSnapshot: string;
    customerPhoneSnapshot: string | null;
    serviceNameSnapshot: string;
    notes: string | null;
    location: { name: string; addressLine1: string | null; city: string | null } | null;
    provider: { timezone: string };
  };
}

async function perform(
  input: {
    row: SyncableRow;
    mapping: { externalCalendarId: string };
    accessToken: string;
  },
  options: CalendarProcessorOptions,
): Promise<GoogleEventResult> {
  const { row, mapping, accessToken } = input;
  const target = {
    accessToken,
    calendarId: mapping.externalCalendarId,
    eventId: row.externalEventId,
  };

  if (row.desiredState === "CANCELLED") {
    if (row.syncedVersion === null) {
      // Never reached Google, so there is nothing to grey out. Cancelling an
      // event that was never created would be a 404 we would then have to
      // classify as success — cheaper and clearer not to make the call.
      return { id: row.externalEventId, etag: row.externalEventEtag, status: "cancelled" };
    }

    try {
      return await options.calendar.cancelEvent(target);
    } catch (error) {
      const { kind, reason } = classifyUnknown(error);

      // Somebody deleted it in Google before we got here. That is the state we
      // were asking for, so it is a success rather than a failure to report.
      if (kind === GoogleFailureKinds.RECREATE || reason === "notFound") {
        return { id: row.externalEventId, etag: null, status: "cancelled" };
      }

      throw error;
    }
  }

  const event = buildBookingEvent({
    bookingId: row.booking.id,
    reference: row.booking.reference,
    serviceName: row.booking.serviceNameSnapshot,
    customerName: row.booking.customerNameSnapshot,
    customerPhone: row.booking.customerPhoneSnapshot,
    notes: row.booking.notes,
    locationName: row.booking.location?.name ?? null,
    locationAddress: addressOf(row.booking.location),
    startAt: row.booking.startAt,
    endAt: row.booking.endAt,
    // The provider's zone, not the tenant's: the entry lands in *their*
    // calendar, and rule 13's distinction between wall-clock and instant is
    // exactly what `timeZone` alongside `dateTime` preserves.
    timezone: row.booking.provider.timezone,
    manageUrl: `${options.appBaseUrl.replace(/\/+$/u, "")}/dashboard/bookings/${row.booking.id}`,
  });

  // Never written to Google before: create with our derived id, which is the
  // whole idempotency mechanism (§2.3).
  if (row.syncedVersion === null) {
    try {
      return await options.calendar.insertEvent({ ...target, event });
    } catch (error) {
      if (classifyUnknown(error).kind !== GoogleFailureKinds.ALREADY_EXISTS) throw error;

      // **The case the unique index cannot cover**: a worker killed between
      // Google's 200 and our row update. Google already has this id, so the
      // insert is refused — and a patch both reconciles whatever version is
      // there and returns the etag we never got to record.
      return options.calendar.patchEvent({ ...target, event });
    }
  }

  try {
    return await options.calendar.patchEvent({ ...target, event });
  } catch (error) {
    if (classifyUnknown(error).kind !== GoogleFailureKinds.RECREATE) throw error;

    // Somebody deleted the event in Google. The database is authoritative
    // (PRD §9.10), so the answer is to put it back rather than accept the
    // deletion — and the id is still ours because we cancel rather than delete.
    return options.calendar.insertEvent({ ...target, event });
  }
}

function addressOf(
  location: { addressLine1: string | null; city: string | null } | null,
): string | null {
  if (location === null) return null;

  const parts = [location.addressLine1, location.city].filter(
    (part): part is string => part !== null && part !== "",
  );

  return parts.length === 0 ? null : parts.join(", ");
}

// ---------------------------------------------------------------------------
// Recording what happened
// ---------------------------------------------------------------------------

/**
 * PENDING → SYNCING, atomically, and only when it is due.
 *
 * `nextAttemptAt` is in the predicate rather than checked afterwards: a job that
 * arrives before its backoff has elapsed must not claim the row, and testing it
 * after the claim would mean releasing something we should never have taken.
 *
 * `attempts` increments here rather than on failure so a worker killed mid-call
 * still counts its try and cannot loop forever.
 */
async function claim(
  prisma: PrismaClient,
  args: { tenantId: string; eventMappingId: string },
  now: Date,
): Promise<{ desiredVersion: number } | null> {
  const { count } = await prisma.calendarEventMapping.updateMany({
    where: {
      id: args.eventMappingId,
      tenantId: args.tenantId,
      syncStatus: "PENDING",
      nextAttemptAt: { lte: now },
    },
    data: { syncStatus: "SYNCING", claimedAt: now, attempts: { increment: 1 } },
  });

  if (count === 0) return null;

  const row = await prisma.calendarEventMapping.findUnique({
    where: { id: args.eventMappingId },
    select: { desiredVersion: true },
  });

  return row;
}

/**
 * Mark the row done — unless the desire moved while we were away.
 *
 * The `desiredVersion` guard is §2.4 doing its job. A reschedule that landed
 * mid-flight has already bumped the row; writing SYNCED here would claim Google
 * holds a version it does not, and nothing would ever correct it because the row
 * would no longer look like work.
 */
async function succeed(
  input: { rowId: string; attemptedVersion: number; result: GoogleEventResult },
  options: CalendarProcessorOptions,
): Promise<CalendarOutcome> {
  const now = new Date();

  const { count } = await options.prisma.calendarEventMapping.updateMany({
    where: { id: input.rowId, desiredVersion: input.attemptedVersion },
    data: {
      syncStatus: "SYNCED",
      syncedVersion: input.attemptedVersion,
      externalEventEtag: input.result.etag,
      lastSyncedAt: now,
      claimedAt: null,
      lastError: null,
      attempts: 0,
    },
  });

  if (count === 1) {
    options.logger.info(
      { eventMappingId: input.rowId, version: input.attemptedVersion },
      "calendar: event synced",
    );
    return CalendarOutcomes.SYNCED;
  }

  // The etag is still worth keeping: it describes the event Google now holds,
  // and the next attempt will patch that same event.
  await options.prisma.calendarEventMapping.update({
    where: { id: input.rowId },
    data: {
      syncStatus: "PENDING",
      externalEventEtag: input.result.etag,
      syncedVersion: input.attemptedVersion,
      claimedAt: null,
      nextAttemptAt: now,
      attempts: 0,
    },
  });

  options.logger.info(
    { eventMappingId: input.rowId, attemptedVersion: input.attemptedVersion },
    "calendar: booking changed mid-sync; re-queued at the newer version",
  );

  return CalendarOutcomes.SUPERSEDED;
}

async function failure(
  error: unknown,
  input: { tenantId: string; rowId: string; integrationId: string; attempts: number },
  options: CalendarProcessorOptions,
): Promise<CalendarOutcome> {
  const { kind, reason } = classifyUnknown(error);
  // `attempts` was already incremented by the claim, so this is the count of
  // attempts made including the one that just failed.
  const attempts = input.attempts;
  const now = new Date();

  if (kind === GoogleFailureKinds.RECONNECT) {
    // Reached when the failure came from the Calendar call rather than the
    // refresh — a scope withdrawn between the two, which is a real sequence
    // because a person can edit permissions at Google while a job is in flight.
    // The integration is marked so the provider is told; the row waits rather
    // than burning its budget.
    await options.prisma.calendarIntegration.update({
      where: { id: input.integrationId },
      data: {
        status: "NEEDS_RECONNECT",
        lastError: reason,
        sealedAccessToken: null,
        accessTokenExpiresAt: null,
      },
    });

    await release(options.prisma, input.rowId, waitForHuman(now), { countsAsAttempt: false });

    // Same email as the token path above, and the same daily key — so a grant
    // that dies mid-batch produces one message however many rows discover it.
    await notifyCalendarDisconnected(
      { tenantId: input.tenantId, integrationId: input.integrationId, reason, now },
      {
        prisma: options.prisma,
        queues: options.queues,
        logger: options.logger,
        appBaseUrl: options.appBaseUrl,
      },
    );

    return CalendarOutcomes.SKIPPED;
  }

  if (kind !== GoogleFailureKinds.RETRY || attempts >= options.maxAttempts) {
    await park(options.prisma, input.rowId, reason);
    options.logger.error(
      { eventMappingId: input.rowId, attempts, kind, reason },
      "calendar: sync failed, parked",
    );
    return CalendarOutcomes.FAILED;
  }

  const delay = googleBackoffMs(attempts, options.random ?? Math.random);
  await release(options.prisma, input.rowId, new Date(now.getTime() + delay), {
    countsAsAttempt: true,
    reason,
  });

  options.logger.warn(
    { eventMappingId: input.rowId, attempts, reason, retryInMs: delay },
    "calendar: sync failed, will retry",
  );

  // Rethrowing is what applies BullMQ's own backoff on top of ours. A parked row
  // must not be retried, so that path returns normally.
  throw new Error(`calendar sync failed: ${reason}`);
}

async function release(
  prisma: PrismaClient,
  id: string,
  nextAttemptAt: Date,
  options: { countsAsAttempt: boolean; reason?: string },
): Promise<void> {
  await prisma.calendarEventMapping.update({
    where: { id },
    data: {
      syncStatus: "PENDING",
      claimedAt: null,
      nextAttemptAt,
      ...(options.countsAsAttempt ? {} : { attempts: { decrement: 1 } }),
      ...(options.reason === undefined ? {} : { lastError: options.reason.slice(0, 1_000) }),
    },
  });
}

async function park(prisma: PrismaClient, id: string, reason: string): Promise<void> {
  await prisma.calendarEventMapping.update({
    where: { id },
    data: {
      // Terminal. The sweep deliberately does not pick FAILED rows up — §26.3
      // forbids retrying a permanently-broken thing — so this waits for a human,
      // a reconnect, or POST /sync.
      syncStatus: "FAILED",
      claimedAt: null,
      lastError: reason.slice(0, 1_000),
    },
  });
}

/**
 * How long a row waits on a person.
 *
 * An hour, and it is not a backoff: nothing is being retried, the row is simply
 * parked until somebody re-consents. Short enough that a provider who reconnects
 * over lunch sees their diary catch up without pressing anything.
 */
function waitForHuman(now: Date): Date {
  return new Date(now.getTime() + 60 * 60 * 1_000);
}
