import type { AvailabilityException, PrismaClient, WorkingHours } from "@bam/db";
import {
  findUncoveredAppointments,
  type DateTimePeriod,
  type ScheduledAppointment,
  type TimePeriod,
  type UncoveredReason,
} from "@bam/availability-engine";
import type { AffectedBooking } from "@bam/contracts";
import type { WorkingHoursEntry } from "./availability.schemas.js";

/**
 * Bookings a schedule change would strand, and bookings already stranded.
 * docs/phase-3-4-schedule-conflicts.md.
 *
 * Both halves of that record are one question asked at two moments — "is this
 * appointment inside the schedule?" — so they are one class. `@bam/availability-
 * engine` decides; this loads what it needs and applies the policy about which
 * appointments are worth asking about (§2.3).
 *
 * ## Why the grouping is not an optimisation
 *
 * A booking is judged against the schedule the slot search would have used for
 * it: working hours scoped to the booking's own location, in the location's zone
 * when it names one, and exceptions narrowed the same way (§2.7). Two bookings
 * on one provider can therefore be judged against different periods in different
 * zones — a chain with a branch across a border is exactly that case. So the
 * bookings are grouped by location before the engine is asked, and the grouping
 * is a correctness requirement rather than a way to save queries.
 *
 * Everything here reads. Nothing writes, and nothing decides — a caller is told
 * what is affected and chooses.
 */

/** The booking fields this needs. Structural, so a Prisma row satisfies it. */
export interface JudgeableBooking {
  id: string;
  reference: string;
  startAt: Date;
  endAt: Date;
  status: string;
  providerId: string;
  serviceId: string;
  locationId: string | null;
  customerNameSnapshot: string;
  serviceNameSnapshot: string;
  provider: { displayName: string; timezone: string };
  location: { timezone: string } | null;
}

/**
 * Statuses worth asking about.
 *
 * `PENDING` counts: it holds the slot, and a request accepted tomorrow into a
 * schedule that no longer covers it is the same problem one day later. The rest
 * are void or historical (§2.3).
 */
const LIVE_STATUSES = new Set(["PENDING", "CONFIRMED"]);

export class ScheduleConflictService {
  constructor(private readonly prisma: PrismaClient) {}

  // -------------------------------------------------------------------------
  // Option 1 — what would this change strand?
  // -------------------------------------------------------------------------

  /**
   * The bookings a proposed week would leave outside the schedule.
   *
   * Judged against the *proposed* entries, not the stored ones — the whole point
   * is to answer the question before the `PUT` lands. Exceptions are read as
   * they stand, because this change does not touch them.
   */
  async findAffectedByWorkingHours(args: {
    tenantId: string;
    providerId: string;
    entries: WorkingHoursEntry[];
    now: Date;
  }): Promise<AffectedBooking[]> {
    const bookings = await this.loadFutureBookings(args);
    if (bookings.length === 0) return [];

    const proposed = args.entries
      // An inactive row is a period switched off, and the search already ignores
      // it (`activeOnly: true` in `planFor`). Judging against it would let an
      // owner strand a booking by unticking a box rather than deleting a row.
      .filter((entry) => entry.active)
      .map(
        (entry): ScopedPeriod => ({
          locationId: entry.locationId ?? null,
          period: {
            weekday: entry.weekday,
            startTime: entry.startTime,
            endTime: entry.endTime,
            ...(entry.validFrom == null ? {} : { validFrom: entry.validFrom }),
            ...(entry.validUntil == null ? {} : { validUntil: entry.validUntil }),
          },
        }),
      );

    return this.judge({
      tenantId: args.tenantId,
      providerId: args.providerId,
      bookings,
      workingPeriods: proposed,
      extraUnavailable: [],
    });
  }

  /**
   * The bookings a proposed closure would cover.
   *
   * The stored schedule is read as it stands and the closure laid over the top,
   * which is what makes the answer identical to what the badge will say once the
   * exception exists. `replacesExceptionId` drops the row being edited from the
   * stored set, or a PATCH that *shrinks* a closure would still be judged
   * against its old extent.
   */
  async findAffectedByException(args: {
    tenantId: string;
    providerId: string;
    startAt: Date;
    endAt: Date;
    locationId: string | null;
    serviceId: string | null;
    replacesExceptionId?: string | undefined;
    now: Date;
  }): Promise<AffectedBooking[]> {
    const bookings = await this.loadFutureBookings(args);
    if (bookings.length === 0) return [];

    const closure: ScopedException = {
      locationId: args.locationId,
      serviceId: args.serviceId,
      period: { startAt: args.startAt.toISOString(), endAt: args.endAt.toISOString() },
    };

    return this.judge({
      tenantId: args.tenantId,
      providerId: args.providerId,
      bookings,
      workingPeriods: null,
      extraUnavailable: [closure],
      ...(args.replacesExceptionId === undefined
        ? {}
        : { ignoreExceptionId: args.replacesExceptionId }),
    });
  }

  // -------------------------------------------------------------------------
  // Option 2 — what is already stranded?
  // -------------------------------------------------------------------------

  /**
   * Which of these bookings are outside their provider's current schedule.
   *
   * Takes rows the caller has already loaded — the bookings list has them, and
   * re-reading a page it is holding would be wasteful — and returns a lookup
   * keyed by booking id. Absent means covered, or not worth asking about.
   *
   * Derived on read and never stored (§2.6): a stored flag would be wrong the
   * moment the schedule changed back, and keeping it right would mean writing to
   * every affected booking on every schedule save.
   */
  async annotate(args: {
    tenantId: string;
    bookings: JudgeableBooking[];
    now: Date;
  }): Promise<Map<string, UncoveredReason>> {
    const relevant = args.bookings.filter((booking) => this.isWorthAsking(booking, args.now));
    const found = new Map<string, UncoveredReason>();

    if (relevant.length === 0) return found;

    const byProvider = new Map<string, JudgeableBooking[]>();
    for (const booking of relevant) {
      const list = byProvider.get(booking.providerId) ?? [];
      list.push(booking);
      byProvider.set(booking.providerId, list);
    }

    // Sequential rather than `Promise.all`: a page of bookings can name a
    // dozen providers, and firing a dozen concurrent pairs of queries at the
    // pool to answer a decoration on a list is not a trade worth making.
    for (const [providerId, bookings] of byProvider) {
      const affected = await this.judge({
        tenantId: args.tenantId,
        providerId,
        bookings,
        workingPeriods: null,
        extraUnavailable: [],
      });

      for (const entry of affected) found.set(entry.id, entry.reason);
    }

    return found;
  }

  // -------------------------------------------------------------------------
  // The shared middle
  // -------------------------------------------------------------------------

  /**
   * Ask the engine, once per location group.
   *
   * `workingPeriods` null means "read the stored ones"; a list means "judge
   * against these instead", which is what makes the working-hours guard able to
   * answer about a week that does not exist yet.
   */
  private async judge(args: {
    tenantId: string;
    providerId: string;
    bookings: JudgeableBooking[];
    workingPeriods: ScopedPeriod[] | null;
    extraUnavailable: ScopedException[];
    ignoreExceptionId?: string | undefined;
  }): Promise<AffectedBooking[]> {
    const { tenantId, providerId, bookings } = args;

    const earliest = new Date(Math.min(...bookings.map((booking) => booking.startAt.getTime())));
    const latest = new Date(Math.max(...bookings.map((booking) => booking.endAt.getTime())));

    const [storedHours, storedExceptions] = await Promise.all([
      args.workingPeriods === null
        ? this.prisma.workingHours.findMany({
            where: { tenantId, providerId, active: true },
          })
        : Promise.resolve<WorkingHours[]>([]),
      this.prisma.availabilityException.findMany({
        where: {
          tenantId,
          providerId,
          // A margin either side, matching `searchSlots`: a closure that starts
          // the evening before still covers the following morning.
          startAt: { lt: addDays(latest, 2) },
          endAt: { gt: addDays(earliest, -2) },
          ...(args.ignoreExceptionId === undefined
            ? {}
            : { NOT: { id: args.ignoreExceptionId } }),
        },
      }),
    ]);

    const periods: ScopedPeriod[] =
      args.workingPeriods ??
      storedHours.map((row) => ({ locationId: row.locationId, period: toTimePeriod(row) }));

    const exceptions: ScopedException[] = [
      ...storedExceptions.map((row) => ({
        locationId: row.locationId,
        serviceId: row.serviceId,
        type: row.type,
        period: toDateTimePeriod(row),
      })),
      ...args.extraUnavailable,
    ];

    const affected: AffectedBooking[] = [];

    for (const [, group] of groupByLocation(bookings)) {
      const first = group[0]!;
      // The zone the schedule is read in — the location's when the booking names
      // one, or the provider's (§2.7). Every booking in a group shares it,
      // because the group *is* the location.
      const timezone = first.location?.timezone ?? first.provider.timezone;
      const locationId = first.locationId;

      // Exactly the predicate `planFor` applies: a row naming no location
      // applies wherever the provider works, a row naming another site does not.
      const inScope = <T extends { locationId: string | null }>(row: T): boolean =>
        row.locationId === null || row.locationId === locationId;

      const uncovered = findUncoveredAppointments({
        timezone,
        workingPeriods: periods.filter(inScope).map((scoped) => scoped.period),
        additionalPeriods: exceptions
          .filter((entry) => entry.type === "ADDITIONAL_AVAILABILITY")
          .filter(inScope)
          .filter((entry) => appliesToServices(entry, group))
          .map((entry) => entry.period),
        unavailablePeriods: exceptions
          .filter((entry) => entry.type !== "ADDITIONAL_AVAILABILITY")
          .filter(inScope)
          .filter((entry) => appliesToServices(entry, group))
          .map((entry) => entry.period),
        appointments: group.map(
          (booking): ScheduledAppointment => ({
            id: booking.id,
            startAt: booking.startAt.toISOString(),
            endAt: booking.endAt.toISOString(),
          }),
        ),
      });

      const byId = new Map(group.map((booking) => [booking.id, booking]));

      for (const entry of uncovered) {
        const booking = byId.get(entry.id);
        if (booking === undefined) continue;

        affected.push({
          id: booking.id,
          reference: booking.reference,
          startAt: booking.startAt.toISOString(),
          endAt: booking.endAt.toISOString(),
          providerId: booking.providerId,
          providerName: booking.provider.displayName,
          serviceName: booking.serviceNameSnapshot,
          customerName: booking.customerNameSnapshot,
          reason: entry.reason,
        });
      }
    }

    // Chronological, because the dialog reads as a list of appointments and the
    // grouping above is an implementation detail nobody should see in the order.
    return affected.sort((left, right) => left.startAt.localeCompare(right.startAt));
  }

  /**
   * A provider's live, future bookings — everything a schedule change could
   * strand, and nothing it could not (§2.3).
   */
  private async loadFutureBookings(args: {
    tenantId: string;
    providerId: string;
    now: Date;
  }): Promise<JudgeableBooking[]> {
    return this.prisma.booking.findMany({
      where: {
        tenantId: args.tenantId,
        providerId: args.providerId,
        status: { in: ["PENDING", "CONFIRMED"] },
        startAt: { gt: args.now },
      },
      select: {
        id: true,
        reference: true,
        startAt: true,
        endAt: true,
        status: true,
        providerId: true,
        serviceId: true,
        locationId: true,
        customerNameSnapshot: true,
        serviceNameSnapshot: true,
        provider: { select: { displayName: true, timezone: true } },
        location: { select: { timezone: true } },
      },
      orderBy: { startAt: "asc" },
    });
  }

  private isWorthAsking(booking: JudgeableBooking, now: Date): boolean {
    return LIVE_STATUSES.has(booking.status) && booking.startAt.getTime() > now.getTime();
  }
}

/** A working period and the site it applies at. */
interface ScopedPeriod {
  locationId: string | null;
  period: TimePeriod;
}

/** An exception and the two scopes that narrow it. */
interface ScopedException {
  locationId: string | null;
  serviceId: string | null;
  type?: string | undefined;
  period: DateTimePeriod;
}

/**
 * An exception scoped to one service applies only to bookings of that service.
 *
 * Asked per group rather than per booking because the engine takes one set of
 * periods for the whole group. Where a group mixes services, a service-scoped
 * exception is kept if it touches any of them — the safe direction: it can add
 * a finding the badge will explain, never hide one.
 */
function appliesToServices(entry: { serviceId: string | null }, group: JudgeableBooking[]): boolean {
  return (
    entry.serviceId === null || group.some((booking) => booking.serviceId === entry.serviceId)
  );
}

/** Keyed by location id, with `null` as its own group. */
function groupByLocation(bookings: JudgeableBooking[]): Map<string | null, JudgeableBooking[]> {
  const groups = new Map<string | null, JudgeableBooking[]>();

  for (const booking of bookings) {
    const list = groups.get(booking.locationId) ?? [];
    list.push(booking);
    groups.set(booking.locationId, list);
  }

  return groups;
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

function toTimePeriod(row: WorkingHours): TimePeriod {
  return {
    weekday: row.weekday,
    startTime: row.startTime,
    endTime: row.endTime,
    // `@db.Date` comes back as UTC midnight, so the date part is the whole
    // value — no zone conversion, and none wanted.
    ...(row.validFrom === null ? {} : { validFrom: row.validFrom.toISOString().slice(0, 10) }),
    ...(row.validUntil === null ? {} : { validUntil: row.validUntil.toISOString().slice(0, 10) }),
  };
}

function toDateTimePeriod(row: AvailabilityException): DateTimePeriod {
  return { startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString() };
}
