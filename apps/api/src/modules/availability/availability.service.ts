import type { AvailabilityException, Prisma, PrismaClient, WorkingHours } from "@bam/db";
import { ErrorCodes, NotFoundError, ValidationError } from "@bam/contracts";
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
import { AvailabilityRepository } from "./availability.repository.js";
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

  constructor(private readonly prisma: PrismaClient) {
    this.repository = new AvailabilityRepository(prisma);
  }

  get repo(): AvailabilityRepository {
    return this.repository;
  }

  // -------------------------------------------------------------------------
  // Working hours
  // -------------------------------------------------------------------------

  async listWorkingHours(args: { tenantId: string; providerId: string }): Promise<WorkingHours[]> {
    await this.assertProviderExists(args.tenantId, args.providerId);
    return this.repository.listWorkingHours(args);
  }

  async setWorkingHours(args: {
    tenantId: string;
    providerId: string;
    entries: WorkingHoursEntry[];
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

    return this.repository.replaceWorkingHours({
      tenantId,
      providerId,
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
  }): Promise<AvailabilityException> {
    const { tenantId, providerId, input } = args;

    await this.assertProviderExists(tenantId, providerId);
    if (input.locationId) await this.assertLocationsExist(tenantId, [input.locationId]);
    if (input.serviceId) await this.assertServiceExists(tenantId, input.serviceId);

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

    return this.repository.updateException({
      tenantId,
      exceptionId,
      data: definedOnly({
        ...input,
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
        // Empty until the booking engine exists (Epic 4) and calendar sync
        // lands (Epic 6). The engine already subtracts all three; there is
        // simply nothing yet to subtract.
        bookings: [],
        activeHolds: [],
        externalBusyPeriods: [],
        minimumNoticeMinutes: plan.minimumNoticeMinutes,
        maximumAdvanceDays: plan.maximumAdvanceDays,
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
