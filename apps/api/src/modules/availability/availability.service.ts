import type { AvailabilityException, Prisma, PrismaClient, WorkingHours } from "@bam/db";
import {
  ConflictError,
  ErrorCodes,
  NotFoundError,
  ValidationError,
  type AffectedBooking,
} from "@bam/contracts";
import {
  generateSlots,
  type AvailabilityQuery,
  type AvailableSlot,
  type DateTimePeriod,
  type TimePeriod,
} from "@bam/availability-engine";
import { definedOnly } from "../../lib/patch.js";
import { providerNotFound } from "../providers/provider.repository.js";
import { serviceNotFound } from "../services/service.repository.js";
import { locationNotFound } from "../locations/location.repository.js";
import { AvailabilityRepository, ScheduleModifiedError } from "./availability.repository.js";
import { ScheduleConflictService } from "./schedule-conflicts.service.js";
import type {
  CreateExceptionBody,
  SlotSearchBody,
  UpdateExceptionBody,
  WorkingHoursEntry,
} from "./availability.schemas.js";

/**
 * Defaults for the fields that mean "inherit".
 *
 * `minimumNoticeMinutes` and `maximumAdvanceDays` are nullable on both Provider
 * and Service (Epic 2), and NULL means inherit. When nothing sets them, these
 * apply. They are constants rather than tenant settings because nothing in the
 * PRD asks for per-tenant defaults yet; when it does, this is the one place to
 * change.
 */
const DEFAULT_MINIMUM_NOTICE_MINUTES = 0;
const DEFAULT_MAXIMUM_ADVANCE_DAYS = 180;

/**
 * Spacing of offered start times.
 *
 * Deliberately not the service duration: a 45-minute service on a 15-minute
 * grid offers 09:00, 09:15, 09:30, which fills a diary far better than
 * 09:00, 09:45, 10:30. A candidate for a tenant setting later (tech-impl
 * §13.1 takes it as an input precisely so it can vary).
 */
const DEFAULT_SLOT_INTERVAL_MINUTES = 15;

/**
 * Stands in for "no horizon" when staff book directly.
 *
 * A number rather than a nullable field, because the engine's contract takes a
 * count of days and threading an optional through it would put a null check in
 * the middle of the date arithmetic for the sake of one caller.
 */
const UNBOUNDED_ADVANCE_DAYS = 36_500;

/** Everything the engine needs about one provider, already resolved. */
interface ProviderPlan {
  providerId: string;
  timezone: string;
  durationMinutes: number;
  minimumNoticeMinutes: number;
  maximumAdvanceDays: number;
  workingPeriods: TimePeriod[];
  additionalPeriods: DateTimePeriod[];
  unavailablePeriods: DateTimePeriod[];
}

/**
 * Schedules, and the slot search built on them.
 *
 * The division of labour matters: this class does the *loading* and the
 * *policy* — which provider, whose hours, which of the several notice windows
 * wins — and @bam/availability-engine does the arithmetic. Nothing here
 * computes a slot, and nothing there touches a database (CLAUDE.md rule 8).
 */
export class AvailabilityService {
  private readonly repository: AvailabilityRepository;
  private readonly conflicts: ScheduleConflictService;

  constructor(private readonly prisma: PrismaClient) {
    this.repository = new AvailabilityRepository(prisma);
    this.conflicts = new ScheduleConflictService(prisma);
  }

  get repo(): AvailabilityRepository {
    return this.repository;
  }

  /** Shared with the bookings module, which needs the same question answered. */
  get scheduleConflicts(): ScheduleConflictService {
    return this.conflicts;
  }

  // -------------------------------------------------------------------------
  // Working hours
  // -------------------------------------------------------------------------

  async listWorkingHours(args: { tenantId: string; providerId: string }): Promise<WorkingHours[]> {
    await this.assertProviderExists(args.tenantId, args.providerId);
    return this.repository.listWorkingHours(args);
  }

  /**
   * Who last saved this week, for the "last changed by" line.
   *
   * No `assertProviderExists`: it is only ever issued alongside
   * `listWorkingHours`, whose check rejects the pair if the diary is not in this
   * tenant, so repeating it would spend a round trip re-proving the same thing.
   * It reads only rows already keyed by `tenantId`, so on its own it still
   * cannot cross a tenant boundary (rule 5).
   */
  async lastWorkingHoursChange(args: {
    tenantId: string;
    providerId: string;
  }): Promise<{ at: Date; by: { userId: string; name: string } | null } | null> {
    return this.repository.findLastWorkingHoursChange(args);
  }

  async setWorkingHours(args: {
    tenantId: string;
    providerId: string;
    entries: WorkingHoursEntry[];
    /** See `setWorkingHoursBodySchema` and phase-3-4 §2.4. */
    acknowledgeAffectedBookings: boolean;
    /**
     * May the caller read this diary's bookings? Decides whether the stranded
     * list carries customer names (diary-delegation §2.12). The route settles
     * it with `canReadProviderBookings`; the service only obeys.
     */
    mayReadBookings: boolean;
    /**
     * The fingerprint the caller's `GET` returned — proof the body was built
     * from a current read of this same set (docs/phase-3-4-diary-delegation.md
     * §2.14). Compared inside the replace transaction, not here.
     */
    expectedFingerprint: string;
    now: Date;
  }): Promise<WorkingHours[]> {
    const { tenantId, providerId, entries } = args;

    await this.assertProviderExists(tenantId, providerId);
    await this.assertLocationsExist(
      tenantId,
      entries.map((entry) => entry.locationId).filter((id): id is string => Boolean(id)),
    );

    for (const entry of entries) {
      // The database CHECK constraints catch a malformed time, but not a period
      // that says nothing. An end equal to its start is zero minutes of work,
      // which is always a mistake in the caller rather than an intent.
      if (entry.startTime === entry.endTime) {
        throw new ValidationError(
          `A working period cannot start and end at the same time (${entry.startTime}).`,
          { field: "workingHours" },
        );
      }
    }

    // Last, after the cheap validation: there is no point reading a diary to
    // report on a body that was never going to be saved.
    if (!args.acknowledgeAffectedBookings) {
      assertNothingStranded(
        await this.conflicts.findAffectedByWorkingHours({
          tenantId,
          providerId,
          entries,
          now: args.now,
        }),
        args.mayReadBookings,
      );
    }

    try {
      return await this.repository.replaceWorkingHours({
        tenantId,
        providerId,
        expectedFingerprint: args.expectedFingerprint,
        rows: entries.map((entry) => ({
        weekday: entry.weekday,
        startTime: entry.startTime,
        endTime: entry.endTime,
        locationId: entry.locationId ?? null,
        validFrom:
          entry.validFrom === undefined || entry.validFrom === null
            ? null
            : new Date(`${entry.validFrom}T00:00:00Z`),
          validUntil:
            entry.validUntil === undefined || entry.validUntil === null
              ? null
              : new Date(`${entry.validUntil}T00:00:00Z`),
          active: entry.active,
        })),
      });
    } catch (cause) {
      if (!(cause instanceof ScheduleModifiedError)) throw cause;

      // Only now, once we know there is a conflict to report: the whole point of
      // the line is naming the person, and looking them up on the happy path
      // would put an audit query on every save to answer a question nobody
      // asked. Null-safe — the trail is fire-and-forget, so it may not have
      // caught up (§2.14.2), and "somebody changed it" is still the right
      // refusal.
      const lastChange = await this.repository.findLastWorkingHoursChange({ tenantId, providerId });

      throw new ConflictError(
        ErrorCodes.SCHEDULE_MODIFIED,
        "This schedule was changed by somebody else while you were editing it. Reload to see their version before saving yours.",
        {
          currentFingerprint: cause.currentFingerprint,
          lastChange:
            lastChange === null ? null : { at: lastChange.at.toISOString(), by: lastChange.by },
        },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Exceptions
  // -------------------------------------------------------------------------

  async listExceptions(args: {
    tenantId: string;
    providerId: string;
    from: Date;
    to: Date;
  }): Promise<AvailabilityException[]> {
    await this.assertProviderExists(args.tenantId, args.providerId);
    return this.repository.listExceptions(args);
  }

  async createException(args: {
    tenantId: string;
    providerId: string;
    input: CreateExceptionBody;
    createdByUserId: string | null;
    source?: "DASHBOARD" | "VOICE" | "CHAT" | "CALENDAR" | "API";
    /** See `setWorkingHours`. */
    mayReadBookings: boolean;
    now: Date;
  }): Promise<AvailabilityException> {
    const { tenantId, providerId, input } = args;

    await this.assertProviderExists(tenantId, providerId);
    if (input.locationId) await this.assertLocationsExist(tenantId, [input.locationId]);
    if (input.serviceId) await this.assertServiceExists(tenantId, input.serviceId);

    // The likelier of the two paths (§2.5): "I am away next week" is a far
    // commoner action than "I no longer work Tuesdays".
    // ADDITIONAL_AVAILABILITY only ever adds time and can strand nothing.
    if (input.type === "UNAVAILABLE" && !input.acknowledgeAffectedBookings) {
      assertNothingStranded(
        await this.conflicts.findAffectedByException({
          tenantId,
          providerId,
          startAt: new Date(input.startAt),
          endAt: new Date(input.endAt),
          locationId: input.locationId ?? null,
          serviceId: input.serviceId ?? null,
          now: args.now,
        }),
        args.mayReadBookings,
      );
    }

    return this.repository.createException({
      tenantId,
      data: {
        providerId,
        type: input.type,
        startAt: new Date(input.startAt),
        endAt: new Date(input.endAt),
        locationId: input.locationId ?? null,
        serviceId: input.serviceId ?? null,
        reason: input.reason ?? null,
        source: args.source ?? "DASHBOARD",
        createdByUserId: args.createdByUserId,
      },
    });
  }

  async updateException(args: {
    tenantId: string;
    exceptionId: string;
    input: UpdateExceptionBody;
    /** See `setWorkingHours`. */
    mayReadBookings: boolean;
    now: Date;
  }): Promise<AvailabilityException> {
    const { tenantId, exceptionId, input } = args;
    const current = await this.repository.findExceptionOrThrow({ tenantId, exceptionId });

    // Merged against the stored row, because a PATCH that moves only one end
    // has nothing to compare against on its own.
    const startAt = input.startAt === undefined ? current.startAt : new Date(input.startAt);
    const endAt = input.endAt === undefined ? current.endAt : new Date(input.endAt);

    if (endAt.getTime() <= startAt.getTime()) {
      throw new ValidationError("endAt must be after startAt.", { field: "endAt" });
    }

    if (input.locationId) await this.assertLocationsExist(tenantId, [input.locationId]);
    if (input.serviceId) await this.assertServiceExists(tenantId, input.serviceId);

    // Every scope is merged the same way the times are: a PATCH that moves only
    // the end must still be judged with the location and service the row
    // already has, or a closure would be checked against a scope nobody asked
    // for.
    const type = input.type ?? current.type;
    const locationId = input.locationId === undefined ? current.locationId : input.locationId;
    const serviceId = input.serviceId === undefined ? current.serviceId : input.serviceId;

    if (type === "UNAVAILABLE" && input.acknowledgeAffectedBookings !== true) {
      assertNothingStranded(
        await this.conflicts.findAffectedByException({
          tenantId,
          providerId: current.providerId,
          startAt,
          endAt,
          locationId,
          serviceId,
          // Its own stored extent must not count against it, or shrinking a
          // closure off a booking would be refused for the booking it is being
          // shrunk off.
          replacesExceptionId: exceptionId,
          now: args.now,
        }),
        args.mayReadBookings,
      );
    }

    return this.repository.updateException({
      tenantId,
      exceptionId,
      data: definedOnly({
        ...input,
        // Not a column. Stripped explicitly rather than left to `definedOnly`,
        // which only drops undefined and would happily try to write `false`.
        acknowledgeAffectedBookings: undefined,
        ...(input.startAt === undefined ? {} : { startAt }),
        ...(input.endAt === undefined ? {} : { endAt }),
      }),
    });
  }

  async deleteException(args: { tenantId: string; exceptionId: string }): Promise<void> {
    return this.repository.deleteException(args);
  }

  // -------------------------------------------------------------------------
  // Slot search
  // -------------------------------------------------------------------------

  /**
   * Find bookable slots. tech-impl §13, §16.
   *
   * `publicOnly` narrows the provider set to those a stranger may book — the
   * same predicate the public catalogue uses, so a provider hidden from the
   * booking page cannot be reached by searching for their slots directly.
   */
  async searchSlots(args: {
    tenantId: string;
    input: SlotSearchBody;
    now: Date;
    publicOnly: boolean;
    /**
     * Staff booking directly from the diary. The notice and advance windows
     * exist to govern strangers; a receptionist fitting somebody in this
     * afternoon is the business exercising its own judgement (see
     * BookingService.createDirectBooking).
     */
    ignoreBookingWindow?: boolean;
    /**
     * Treat this booking's own reservation as free.
     *
     * A reschedule asks "could this booking move here?", and its current
     * reservation is about to move out of the way. Without this, a booking
     * could never be moved to an overlapping time — including thirty minutes
     * later, which is the most common request there is.
     */
    ignoreBookingId?: string;
  }): Promise<(AvailableSlot & { providerId: string })[]> {
    const { tenantId, input } = args;

    const service = await this.prisma.service.findFirst({
      where: {
        id: input.serviceId,
        tenantId,
        archivedAt: null,
        ...(args.publicOnly ? { active: true } : {}),
      },
    });

    if (!service) throw serviceNotFound();

    const location = input.locationId
      ? await this.prisma.location.findFirst({
          where: {
            id: input.locationId,
            tenantId,
            archivedAt: null,
            ...(args.publicOnly ? { active: true } : {}),
          },
        })
      : null;

    if (input.locationId && !location) throw locationNotFound();

    // Nothing further is asked about the service and the location. A location is
    // one of the organization's sites and nothing more; whether a service is
    // offered there is answered by whether a provider who offers it works there,
    // which the working-hours scope below already decides. `service_locations`
    // used to answer it a second time and was removed — see the phase record.

    // Providers who actually offer this service. An assignment that is inactive
    // at either end is not an offer.
    const assignments = await this.prisma.providerService.findMany({
      where: {
        tenantId,
        serviceId: service.id,
        active: true,
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
        provider: {
          archivedAt: null,
          ...(args.publicOnly ? { active: true, onlineBookingEnabled: true } : {}),
          ...(location === null
            ? {}
            : { locations: { some: { locationId: location.id, active: true } } }),
        },
      },
      include: { provider: true },
    });

    if (assignments.length === 0) {
      // Not an error: a real search that matched nobody. An empty slot list is
      // the honest answer, and it is what the booking page renders as "no
      // availability" rather than as a failure.
      return [];
    }

    const windowFrom = new Date(`${input.dateFrom}T00:00:00Z`);
    // A generous margin either side, because a calendar day in the provider's
    // zone is never exactly a UTC day and a night shift can start the evening
    // before.
    const windowTo = new Date(`${input.dateTo}T00:00:00Z`);
    windowFrom.setUTCDate(windowFrom.getUTCDate() - 2);
    windowTo.setUTCDate(windowTo.getUTCDate() + 2);

    // Everything already claimed on these providers' diaries.
    //
    // One query over capacity_reservations rather than separate reads of
    // bookings and holds, because that table is the single answer to "is this
    // time taken" — it is what the exclusion constraint enforces, and reading
    // anything else here would let the search disagree with the constraint that
    // decides. The spans are already the occupied windows, buffers included.
    const reservations = await this.repository.listBusyReservations({
      tenantId,
      providerIds: assignments.map((assignment) => assignment.providerId),
      from: windowFrom,
      to: windowTo,
      now: args.now,
      ...(args.ignoreBookingId === undefined ? {} : { excludeBookingId: args.ignoreBookingId }),
    });

    const busyByProvider = new Map<
      string,
      { bookings: DateTimePeriod[]; holds: DateTimePeriod[] }
    >();
    for (const reservation of reservations) {
      const entry = busyByProvider.get(reservation.providerId) ?? { bookings: [], holds: [] };
      const period: DateTimePeriod = {
        startAt: reservation.startAt.toISOString(),
        endAt: reservation.endAt.toISOString(),
      };
      // The engine subtracts both identically (tech-impl §11.3). They are kept
      // apart so a slot that vanished because somebody is mid-checkout is
      // distinguishable in a log from one that is genuinely booked.
      if (reservation.bookingId === null) entry.holds.push(period);
      else entry.bookings.push(period);
      busyByProvider.set(reservation.providerId, entry);
    }

    const slots: (AvailableSlot & { providerId: string })[] = [];

    for (const assignment of assignments) {
      const plan = await this.planFor({
        tenantId,
        assignment,
        service,
        locationId: location?.id,
        locationTimezone: location?.timezone,
        windowFrom,
        windowTo,
      });

      const query: AvailabilityQuery = {
        providerId: plan.providerId,
        serviceDurationMinutes: plan.durationMinutes,
        bufferBeforeMinutes: service.bufferBeforeMinutes,
        bufferAfterMinutes: service.bufferAfterMinutes,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        timezone: plan.timezone,
        slotIntervalMinutes: DEFAULT_SLOT_INTERVAL_MINUTES,
        workingPeriods: plan.workingPeriods,
        additionalPeriods: plan.additionalPeriods,
        unavailablePeriods: plan.unavailablePeriods,
        bookings: busyByProvider.get(plan.providerId)?.bookings ?? [],
        activeHolds: busyByProvider.get(plan.providerId)?.holds ?? [],
        // Still empty: calendar sync lands in Epic 6. The engine subtracts it
        // already, so that epic supplies data rather than changing logic.
        externalBusyPeriods: [],
        minimumNoticeMinutes: args.ignoreBookingWindow === true ? 0 : plan.minimumNoticeMinutes,
        maximumAdvanceDays:
          args.ignoreBookingWindow === true ? UNBOUNDED_ADVANCE_DAYS : plan.maximumAdvanceDays,
        now: args.now.toISOString(),
      };

      for (const slot of generateSlots(query)) {
        slots.push({ ...slot, providerId: plan.providerId });
      }
    }

    // One list across providers, in time order — what a customer scanning for
    // "anything on Tuesday morning" wants to read.
    return slots.sort(
      (left, right) =>
        Date.parse(left.startAt) - Date.parse(right.startAt) ||
        left.providerId.localeCompare(right.providerId),
    );
  }

  /** Resolve one provider's schedule and policy into engine inputs. */
  private async planFor(args: {
    tenantId: string;
    assignment: Prisma.ProviderServiceGetPayload<{ include: { provider: true } }>;
    service: {
      durationMinutes: number;
      minimumNoticeMinutes: number | null;
      maximumAdvanceDays: number | null;
    };
    locationId: string | undefined;
    locationTimezone: string | undefined;
    windowFrom: Date;
    windowTo: Date;
  }): Promise<ProviderPlan> {
    const { assignment, service } = args;
    const provider = assignment.provider;

    const [workingHours, exceptions] = await Promise.all([
      this.repository.listWorkingHours({
        tenantId: args.tenantId,
        providerId: provider.id,
        locationId: args.locationId,
        activeOnly: true,
      }),
      this.repository.listExceptions({
        tenantId: args.tenantId,
        providerId: provider.id,
        from: args.windowFrom,
        to: args.windowTo,
      }),
    ]);

    const relevant = exceptions.filter(
      (exception) =>
        // An exception scoped to a location or service applies only there.
        (exception.locationId === null || exception.locationId === args.locationId) &&
        (exception.serviceId === null || exception.serviceId === assignment.serviceId),
    );

    return {
      providerId: provider.id,
      // The location's zone wins when the search names one: a branch across a
      // border keeps its own opening hours (tech-impl §13.4).
      timezone: args.locationTimezone ?? provider.timezone,
      durationMinutes: assignment.customDurationMinutes ?? service.durationMinutes,
      minimumNoticeMinutes: mostRestrictiveNotice(
        provider.minimumNoticeMinutes,
        service.minimumNoticeMinutes,
      ),
      maximumAdvanceDays: mostRestrictiveAdvance(
        provider.maximumAdvanceDays,
        service.maximumAdvanceDays,
      ),
      workingPeriods: workingHours.map(toTimePeriod),
      additionalPeriods: relevant
        .filter((exception) => exception.type === "ADDITIONAL_AVAILABILITY")
        .map(toDateTimePeriod),
      unavailablePeriods: relevant
        .filter((exception) => exception.type === "UNAVAILABLE")
        .map(toDateTimePeriod),
    };
  }

  // -------------------------------------------------------------------------
  // Existence checks
  //
  // All scoped by tenant, so anything belonging to someone else reads as
  // "does not exist" rather than "not yours" (tech-impl §34.2).
  // -------------------------------------------------------------------------

  private async assertProviderExists(tenantId: string, providerId: string): Promise<void> {
    const provider = await this.prisma.provider.findFirst({
      where: { id: providerId, tenantId, archivedAt: null },
      select: { id: true },
    });

    if (!provider) throw providerNotFound();
  }

  private async assertServiceExists(tenantId: string, serviceId: string): Promise<void> {
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, tenantId, archivedAt: null },
      select: { id: true },
    });

    if (!service) throw serviceNotFound();
  }

  private async assertLocationsExist(tenantId: string, locationIds: string[]): Promise<void> {
    const unique = [...new Set(locationIds)];
    if (unique.length === 0) return;

    const found = await this.prisma.location.findMany({
      where: { tenantId, id: { in: unique }, archivedAt: null },
      select: { id: true },
    });

    if (found.length !== unique.length) {
      throw new NotFoundError("Location not found.", ErrorCodes.LOCATION_NOT_FOUND);
    }
  }
}

/**
 * Refuse a schedule change that would strand bookings — once.
 * docs/phase-3-4-schedule-conflicts.md §2.4.
 *
 * The list travels in `details` so the caller can show what it is about to do
 * without a second request, and the same request re-sent with
 * `acknowledgeAffectedBookings` succeeds. This is not a permission check: the
 * change belongs to the clinic (phase-2-3 §2.6), and refusing outright would
 * leave a business that genuinely needs to move its hours with cancelling real
 * appointments as its only way forward.
 *
 * The check re-runs on the acknowledged call, so a booking made between the two
 * requests is caught by the second one rather than slipping through a window.
 */
function assertNothingStranded(affected: AffectedBooking[], mayReadBookings: boolean): void {
  if (affected.length === 0) return;

  throw new ConflictError(
    ErrorCodes.SCHEDULE_CONFLICTS_BOOKINGS,
    affected.length === 1
      ? "This change leaves 1 existing booking outside the schedule."
      : `This change leaves ${String(affected.length)} existing bookings outside the schedule.`,
    {
      // Diary delegation split availability from bookings, so a caller may now
      // legitimately be saving this schedule while holding no right to read its
      // appointments. The count, the times and the references are the decision;
      // the names are not (docs/phase-3-4-diary-delegation.md §2.12).
      affectedBookings: mayReadBookings
        ? affected
        : affected.map((booking) => ({ ...booking, customerName: null })),
    },
  );
}

/**
 * The most restrictive notice wins.
 *
 * A provider who needs a day's warning and a service that needs two hours means
 * a day: the stricter of the two is the one that would be violated. NULL means
 * "inherit", so it never constrains anything.
 */
function mostRestrictiveNotice(...values: (number | null)[]): number {
  const set = values.filter((value): value is number => value !== null);
  return set.length === 0 ? DEFAULT_MINIMUM_NOTICE_MINUTES : Math.max(...set);
}

/** Same rule, opposite direction: the shortest booking horizon wins. */
function mostRestrictiveAdvance(...values: (number | null)[]): number {
  const set = values.filter((value): value is number => value !== null);
  return set.length === 0 ? DEFAULT_MAXIMUM_ADVANCE_DAYS : Math.min(...set);
}

function toTimePeriod(row: WorkingHours): TimePeriod {
  return {
    weekday: row.weekday,
    startTime: row.startTime,
    endTime: row.endTime,
    // `@db.Date` comes back as UTC midnight, so the date part is the whole
    // value — no zone conversion, and none wanted.
    validFrom: row.validFrom ? row.validFrom.toISOString().slice(0, 10) : undefined,
    validUntil: row.validUntil ? row.validUntil.toISOString().slice(0, 10) : undefined,
  };
}

function toDateTimePeriod(row: AvailabilityException): DateTimePeriod {
  return { startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString() };
}
