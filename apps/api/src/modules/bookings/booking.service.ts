import type { Booking, Customer, Location, Prisma, PrismaClient, Provider, Service } from "@bam/db";
import {
  AppError,
  ConflictError,
  ErrorCodes,
  NotFoundError,
  ValidationError,
  type ErrorCode,
} from "@bam/contracts";
import {
  BookingStatuses,
  DEFAULT_HOLD_DURATION_MINUTES,
  buildBookingSnapshot,
  checkBookingWindow,
  checkCancellable,
  checkHoldReleasable,
  checkHoldUsable,
  checkReschedulable,
  checkTransition,
  customerMatches,
  holdExpiresAt,
  initialBookingStatus,
  mostRestrictiveAdvance,
  mostRestrictiveNotice,
  normalizeEmail,
  normalizePhone,
  occupiedSpanFor,
  releasesCapacity,
  type BookingSource,
  type BookingStatus,
  type Decision,
} from "@bam/booking-engine";
import { AvailabilityService } from "../availability/availability.service.js";
import { providerNotFound } from "../providers/provider.repository.js";
import { serviceNotFound } from "../services/service.repository.js";
import { locationNotFound } from "../locations/location.repository.js";
import {
  BookingRepository,
  createManagementToken,
  isSlotConflict,
  slotTaken,
  type BookingWithRelations,
  type Db,
} from "./booking.repository.js";
import type {
  CancelBody,
  ConfirmBookingBody,
  CreateBookingBody,
  CreateHoldBody,
  CustomerInput,
  ReschedulePrepareBody,
  UpdateBookingBody,
} from "./booking.schemas.js";

/** Matches AvailabilityService, which resolves the same inheritance for search. */
const DEFAULT_MINIMUM_NOTICE_MINUTES = 0;
const DEFAULT_MAXIMUM_ADVANCE_DAYS = 180;

/**
 * Everything a booking needs to know, resolved once.
 *
 * Assembled by {@link resolvePlan} so that the hold path, the staff path and
 * the reschedule path cannot disagree about a service's duration or a
 * provider's notice period.
 */
interface BookingPlan {
  provider: Provider;
  service: Service;
  location: Location | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeMinutes: number;
  maximumAdvanceDays: number;
  timezone: string;
}

export interface AuditContext {
  actorType: "USER" | "SYSTEM" | "CUSTOMER" | "PLATFORM_ADMIN";
  actorId: string | null;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Holds, bookings, and the moves between them. tech-impl §11, §14.
 *
 * ## Where the work happens
 *
 * @bam/booking-engine decides; this class loads, transacts and persists. The
 * division is the one Epic 3 drew between AvailabilityService and the
 * availability engine, and it is what keeps the hard parts testable without a
 * stack.
 *
 * ## Audit rows are written inside the transaction
 *
 * Deliberately *not* through `request.audit()`, which is fire-and-forget and
 * documents itself as best-effort. That is right for a settings change and
 * wrong here: a booking whose creation left no trace is a dispute nobody can
 * settle. The audit row and the outbox event commit with the booking or not at
 * all — which is the same reason the outbox exists (tech-impl §12).
 */
export class BookingService {
  private readonly repository: BookingRepository;
  private readonly availability: AvailabilityService;

  constructor(private readonly prisma: PrismaClient) {
    this.repository = new BookingRepository(prisma);
    this.availability = new AvailabilityService(prisma);
  }

  get repo(): BookingRepository {
    return this.repository;
  }

  // -------------------------------------------------------------------------
  // Holds
  // -------------------------------------------------------------------------

  /**
   * Claim a slot. tech-impl §11.4.
   *
   * Steps 1-5 of §11.4 are validation and happen before the transaction: they
   * only read, and holding a transaction open across them would widen the
   * window every concurrent booking contends in. Steps 6-7 are the two writes
   * that must be atomic, and the sweep joins them because an expired
   * reservation still blocks — see BookingRepository.sweepExpired.
   */
  async createHold(args: {
    tenantId: string;
    input: CreateHoldBody;
    now: Date;
    publicOnly: boolean;
    holdMinutes?: number;
  }): Promise<{ hold: Awaited<ReturnType<BookingRepository["createHold"]>>; plan: BookingPlan }> {
    const { tenantId, input, now } = args;

    const plan = await this.resolvePlan({
      tenantId,
      providerId: input.providerId,
      serviceId: input.serviceId,
      locationId: input.locationId,
      publicOnly: args.publicOnly,
    });

    const span = occupiedSpanFor({
      startAt: input.startAt,
      durationMinutes: plan.durationMinutes,
      bufferBeforeMinutes: plan.bufferBeforeMinutes,
      bufferAfterMinutes: plan.bufferAfterMinutes,
    });

    // The window is enforced here rather than at confirmation. A hold *is* the
    // customer's claim on the slot; re-testing the notice period four minutes
    // later would let a hold made legitimately at 08:58 be refused at 09:01 for
    // a rule it satisfied when it was made.
    this.enforce(
      checkBookingWindow({
        startAt: span.appointment.startAt,
        now: now.toISOString(),
        minimumNoticeMinutes: plan.minimumNoticeMinutes,
        maximumAdvanceDays: plan.maximumAdvanceDays,
      }),
    );

    await this.assertSlotIsOffered({ tenantId, plan, span, now, publicOnly: args.publicOnly });

    const expiresAt = new Date(
      holdExpiresAt(now.toISOString(), args.holdMinutes ?? DEFAULT_HOLD_DURATION_MINUTES),
    );

    try {
      const hold = await this.prisma.$transaction(async (tx) => {
        await this.repository.sweepExpired(tx, { providerId: plan.provider.id, now });

        return this.repository.createHold(tx, {
          tenantId,
          data: {
            providerId: plan.provider.id,
            serviceId: plan.service.id,
            locationId: plan.location?.id ?? null,
            customerId: null,
            sessionId: input.sessionId,
            startAt: new Date(span.appointment.startAt),
            endAt: new Date(span.appointment.endAt),
            expiresAt,
          },
          occupied: {
            startAt: new Date(span.occupied.startAt),
            endAt: new Date(span.occupied.endAt),
          },
        });
      });

      return { hold, plan };
    } catch (error) {
      // The database refused because somebody else got there first. This is the
      // expected outcome of a race, not a fault.
      if (isSlotConflict(error)) throw slotTaken();
      throw error;
    }
  }

  /**
   * Give a slot back.
   *
   * `sessionId` is checked when supplied so one customer cannot release
   * another's hold by guessing an id. Staff callers omit it — they are
   * authenticated and authorised, which is a stronger claim than a session
   * string.
   */
  async releaseHold(args: {
    tenantId: string;
    holdId: string;
    sessionId?: string | undefined;
  }): Promise<void> {
    const hold = await this.repository.findHoldOrThrow({
      tenantId: args.tenantId,
      holdId: args.holdId,
    });

    if (args.sessionId !== undefined && hold.sessionId !== args.sessionId) {
      // Same 404 as a hold that does not exist: a stranger learns nothing about
      // whether the id was real.
      throw new NotFoundError("This reservation no longer exists.", ErrorCodes.HOLD_NOT_FOUND);
    }

    this.enforce(checkHoldReleasable(hold), { HOLD_ALREADY_CONFIRMED: 409 });

    await this.prisma.$transaction(async (tx) => {
      await this.repository.releaseHold(tx, { tenantId: args.tenantId, holdId: args.holdId });
    });
  }

  async getHold(args: {
    tenantId: string;
    holdId: string;
    sessionId?: string | undefined;
  }): Promise<Awaited<ReturnType<BookingRepository["findHoldOrThrow"]>>> {
    const hold = await this.repository.findHoldOrThrow(args);

    if (args.sessionId !== undefined && hold.sessionId !== args.sessionId) {
      throw new NotFoundError("This reservation no longer exists.", ErrorCodes.HOLD_NOT_FOUND);
    }

    return hold;
  }

  // -------------------------------------------------------------------------
  // Confirmation
  // -------------------------------------------------------------------------

  /**
   * Turn a hold into a booking. tech-impl §11.5.
   *
   * The whole sequence is one transaction, and the reservation is *adopted*
   * rather than replaced, so the slot is guarded continuously — there is no
   * instant at which it is free for somebody else to take.
   */
  async confirmBooking(args: {
    tenantId: string;
    input: ConfirmBookingBody;
    now: Date;
    source: BookingSource;
    createdByUserId: string | null;
    audit: AuditContext;
  }): Promise<{ booking: BookingWithRelations; managementToken: string }> {
    const { tenantId, input, now } = args;

    const result = await this.prisma.$transaction(async (tx) => {
      // Step 1: lock. Two confirmations of one hold must not both proceed.
      const hold = await this.repository.lockHold(tx, { tenantId, holdId: input.holdId });

      // Steps 2-3: is it still usable? The engine works in ISO instants, so the
      // row's Date is converted here rather than the engine learning about Date.
      this.enforce(
        checkHoldUsable({ ...hold, expiresAt: hold.expiresAt.toISOString() }, now.toISOString()),
        {
          HOLD_EXPIRED: 409,
          HOLD_RELEASED: 404,
          HOLD_ALREADY_CONFIRMED: 409,
        },
      );

      const plan = await this.resolvePlan({
        tenantId,
        providerId: hold.providerId,
        serviceId: hold.serviceId,
        locationId: hold.locationId ?? undefined,
        // The hold already passed the public filters when it was created; a
        // service deactivated in the meantime must not strand a customer who is
        // mid-checkout.
        publicOnly: false,
        db: tx,
      });

      // Step 4.
      const customer = await this.upsertCustomer(tx, tenantId, input.customer);

      const snapshot = buildBookingSnapshot({
        customer: { fullName: customer.fullName, email: customer.email, phone: customer.phone },
        serviceName: plan.service.name,
        priceMinor: plan.service.priceMinor,
        currency: plan.service.currency,
      });

      const management = createManagementToken();
      const reference = await this.repository.allocateReference(tx, tenantId);

      // Step 5. The service may ask for approval, while the owner may opt this
      // provider's whole diary into automatic confirmation. Either outcome
      // still holds the slot.
      const status = initialBookingStatus(plan.service, plan.provider);

      const booking = await this.repository.createBooking(tx, {
        tenantId,
        data: {
          reference,
          customerId: customer.id,
          providerId: hold.providerId,
          serviceId: hold.serviceId,
          locationId: hold.locationId,
          holdId: hold.id,
          startAt: hold.startAt,
          endAt: hold.endAt,
          status,
          source: args.source,
          customerNameSnapshot: snapshot.customerName,
          customerEmailSnapshot: snapshot.customerEmail,
          customerPhoneSnapshot: snapshot.customerPhone,
          serviceNameSnapshot: snapshot.serviceName,
          priceMinorSnapshot: snapshot.priceMinor,
          currencySnapshot: snapshot.currency,
          notes: input.notes ?? null,
          createdByUserId: args.createdByUserId,
          managementTokenHash: management.hash,
        },
      });

      // Step 6: the reservation changes hands without ever going inactive.
      await this.repository.adoptReservation(tx, {
        tenantId,
        holdId: hold.id,
        bookingId: booking.id,
      });

      // Step 7.
      await tx.bookingHold.update({
        where: { id: hold.id },
        data: { status: "CONFIRMED", customerId: customer.id },
      });

      // Steps 8-9.
      await this.writeAudit(tx, args.audit, {
        tenantId,
        action: "booking.created",
        entityId: booking.id,
        after: { reference, status, startAt: booking.startAt, providerId: booking.providerId },
      });

      await this.writeOutbox(tx, {
        tenantId,
        eventType: status === BookingStatuses.PENDING ? "BOOKING_REQUESTED" : "BOOKING_CONFIRMED",
        bookingId: booking.id,
        // The customer's first email is the one that carries their manage link,
        // and this is the only moment the raw token exists.
        managementToken: management.token,
      });

      return { bookingId: booking.id, managementToken: management.token };
    });

    return {
      booking: await this.repository.findByIdOrThrow({ tenantId, bookingId: result.bookingId }),
      managementToken: result.managementToken,
    };
  }

  /**
   * A booking made straight from the diary, with no hold. Staff only.
   *
   * The notice and advance windows are deliberately *not* enforced. They exist
   * to stop strangers booking at two minutes' notice; a receptionist fitting
   * somebody in this afternoon is the business exercising its own judgement,
   * and refusing that would just teach people to work around the system. What
   * still applies is everything that is not a matter of preference: the slot
   * must be within working hours, must not be in the past, and the exclusion
   * constraint decides the rest.
   */
  async createDirectBooking(args: {
    tenantId: string;
    input: CreateBookingBody;
    now: Date;
    createdByUserId: string | null;
    audit: AuditContext;
  }): Promise<{ booking: BookingWithRelations; managementToken: string }> {
    const { tenantId, input, now } = args;

    const plan = await this.resolvePlan({
      tenantId,
      providerId: input.providerId,
      serviceId: input.serviceId,
      locationId: input.locationId,
      publicOnly: false,
    });

    const span = occupiedSpanFor({
      startAt: input.startAt,
      durationMinutes: plan.durationMinutes,
      bufferBeforeMinutes: plan.bufferBeforeMinutes,
      bufferAfterMinutes: plan.bufferAfterMinutes,
    });

    if (Date.parse(span.appointment.startAt) < now.getTime()) {
      throw new ValidationError("A booking cannot start in the past.", { field: "startAt" });
    }

    await this.assertSlotIsOffered({
      tenantId,
      plan,
      span,
      now,
      publicOnly: false,
      // Staff bypass the notice window, so the search that checks the schedule
      // must bypass it too — otherwise this afternoon's slot is "not offered"
      // for a reason that does not apply to the person asking.
      ignoreNotice: true,
    });

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await this.repository.sweepExpired(tx, { providerId: plan.provider.id, now });

        const customer = await this.upsertCustomer(tx, tenantId, input.customer);
        const snapshot = buildBookingSnapshot({
          customer: { fullName: customer.fullName, email: customer.email, phone: customer.phone },
          serviceName: plan.service.name,
          priceMinor: plan.service.priceMinor,
          currency: plan.service.currency,
        });

        const management = createManagementToken();
        const reference = await this.repository.allocateReference(tx, tenantId);

        const booking = await this.repository.createBooking(tx, {
          tenantId,
          data: {
            reference,
            customerId: customer.id,
            providerId: plan.provider.id,
            serviceId: plan.service.id,
            locationId: plan.location?.id ?? null,
            startAt: new Date(span.appointment.startAt),
            endAt: new Date(span.appointment.endAt),
            // Staff-made bookings skip approval: the person who would approve
            // it is the one making it.
            status: BookingStatuses.CONFIRMED,
            source: args.input.source ?? "STAFF",
            customerNameSnapshot: snapshot.customerName,
            customerEmailSnapshot: snapshot.customerEmail,
            customerPhoneSnapshot: snapshot.customerPhone,
            serviceNameSnapshot: snapshot.serviceName,
            priceMinorSnapshot: snapshot.priceMinor,
            currencySnapshot: snapshot.currency,
            notes: input.notes ?? null,
            createdByUserId: args.createdByUserId,
            managementTokenHash: management.hash,
          },
        });

        await this.repository.createBookingReservation(tx, {
          tenantId,
          providerId: plan.provider.id,
          bookingId: booking.id,
          startAt: new Date(span.occupied.startAt),
          endAt: new Date(span.occupied.endAt),
        });

        await this.writeAudit(tx, args.audit, {
          tenantId,
          action: "booking.created",
          entityId: booking.id,
          after: { reference, status: booking.status, startAt: booking.startAt, source: "STAFF" },
        });

        await this.writeOutbox(tx, {
          tenantId,
          eventType: "BOOKING_CONFIRMED",
          bookingId: booking.id,
          // A booking taken at the desk earns the same emailed link as one taken
          // on the web — the customer still has to be able to cancel it.
          managementToken: management.token,
        });

        return { bookingId: booking.id, managementToken: management.token };
      });

      return {
        booking: await this.repository.findByIdOrThrow({ tenantId, bookingId: result.bookingId }),
        managementToken: result.managementToken,
      };
    } catch (error) {
      if (isSlotConflict(error)) throw slotTaken();
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Reschedule
  // -------------------------------------------------------------------------

  /** Preview only — writes nothing. tech-impl §23.2. */
  async prepareReschedule(args: {
    tenantId: string;
    bookingId: string;
    input: ReschedulePrepareBody;
    now: Date;
  }): Promise<{
    booking: BookingWithRelations;
    proposed: { startAt: string; endAt: string };
    decision: Decision<string>;
  }> {
    const booking = await this.repository.findByIdOrThrow(args);
    const plan = await this.planForBooking(args.tenantId, booking);

    const span = occupiedSpanFor({
      startAt: args.input.newStartAt,
      durationMinutes: plan.durationMinutes,
      bufferBeforeMinutes: plan.bufferBeforeMinutes,
      bufferAfterMinutes: plan.bufferAfterMinutes,
    });

    const decision = checkReschedulable({
      status: booking.status,
      currentStartAt: booking.startAt.toISOString(),
      newStartAt: span.appointment.startAt,
      now: args.now.toISOString(),
      cancellationNoticeMinutes: null,
      minimumNoticeMinutes: plan.minimumNoticeMinutes,
      maximumAdvanceDays: plan.maximumAdvanceDays,
    });

    return { booking, proposed: span.appointment, decision };
  }

  /**
   * Move a booking. Epic 4's fourth exit criterion: transactional.
   *
   * The old reservation is not released and then re-acquired — that sequence
   * has a gap in the middle, and under load somebody books into it. Instead the
   * existing reservation row is *moved*: one UPDATE, re-checked by the
   * exclusion constraint, and if the new time collides the whole transaction
   * rolls back with the booking still sitting where it was.
   */
  async confirmReschedule(args: {
    tenantId: string;
    bookingId: string;
    input: ReschedulePrepareBody & { version?: number | undefined };
    now: Date;
    audit: AuditContext;
  }): Promise<BookingWithRelations> {
    const { tenantId, bookingId, now } = args;

    const preview = await this.prepareReschedule({ tenantId, bookingId, input: args.input, now });
    this.enforce(preview.decision, RESCHEDULE_STATUS_MAP);

    const plan = await this.planForBooking(tenantId, preview.booking);
    const span = occupiedSpanFor({
      startAt: args.input.newStartAt,
      durationMinutes: plan.durationMinutes,
      bufferBeforeMinutes: plan.bufferBeforeMinutes,
      bufferAfterMinutes: plan.bufferAfterMinutes,
    });

    await this.assertSlotIsOffered({
      tenantId,
      plan,
      span,
      now,
      publicOnly: false,
      // The booking's own reservation is about to move out of the way, so it
      // must not count as something blocking the destination.
      ignoreBookingId: bookingId,
    });

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.repository.sweepExpired(tx, { providerId: preview.booking.providerId, now });

        await this.repository.moveReservation(tx, {
          tenantId,
          bookingId,
          startAt: new Date(span.occupied.startAt),
          endAt: new Date(span.occupied.endAt),
        });

        await this.repository.updateBooking(tx, {
          tenantId,
          bookingId,
          expectedVersion: args.input.version ?? preview.booking.version,
          data: {
            startAt: new Date(span.appointment.startAt),
            endAt: new Date(span.appointment.endAt),
            ...(args.input.locationId === undefined ? {} : { locationId: args.input.locationId }),
          },
        });

        await this.writeAudit(tx, args.audit, {
          tenantId,
          action: "booking.rescheduled",
          entityId: bookingId,
          before: { startAt: preview.booking.startAt, endAt: preview.booking.endAt },
          after: { startAt: span.appointment.startAt, endAt: span.appointment.endAt },
        });

        await this.writeOutbox(tx, {
          tenantId,
          eventType: "BOOKING_RESCHEDULED",
          bookingId,
          // Where it used to be. The only fact in the "your appointment has
          // moved" email that cannot be re-read from the booking, because the
          // booking has already moved by the time the worker looks.
          previousStartAt: preview.booking.startAt.toISOString(),
        });
      });
    } catch (error) {
      if (isSlotConflict(error)) throw slotTaken();
      throw error;
    }

    return this.repository.findByIdOrThrow({ tenantId, bookingId });
  }

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  async prepareCancellation(args: {
    tenantId: string;
    bookingId: string;
    now: Date;
  }): Promise<{ booking: BookingWithRelations; decision: Decision<string> }> {
    const booking = await this.repository.findByIdOrThrow(args);

    return {
      booking,
      decision: checkCancellable({
        status: booking.status,
        startAt: booking.startAt.toISOString(),
        now: args.now.toISOString(),
        // No column states a number of minutes; see @bam/booking-engine's
        // checkCancellable for why this is a parameter and not a schema change.
        cancellationNoticeMinutes: null,
      }),
    };
  }

  async confirmCancellation(args: {
    tenantId: string;
    bookingId: string;
    input: CancelBody;
    now: Date;
    audit: AuditContext;
  }): Promise<BookingWithRelations> {
    const { tenantId, bookingId, now } = args;

    const preview = await this.prepareCancellation({ tenantId, bookingId, now });
    this.enforce(preview.decision, CANCELLATION_STATUS_MAP);

    await this.prisma.$transaction(async (tx) => {
      await this.repository.updateBooking(tx, {
        tenantId,
        bookingId,
        expectedVersion: args.input.version ?? preview.booking.version,
        data: {
          status: BookingStatuses.CANCELLED,
          cancelledAt: now,
          cancellationReason: args.input.reason ?? null,
        },
      });

      // The slot goes back on sale the instant this commits. That is precisely
      // why un-cancelling is not a status transition — see the engine.
      await this.repository.releaseBookingReservation(tx, { tenantId, bookingId });

      await this.writeAudit(tx, args.audit, {
        tenantId,
        action: "booking.cancelled",
        entityId: bookingId,
        before: { status: preview.booking.status, startAt: preview.booking.startAt },
        after: { status: BookingStatuses.CANCELLED },
      });

      await this.writeOutbox(tx, { tenantId, eventType: "BOOKING_CANCELLED", bookingId });
    });

    return this.repository.findByIdOrThrow({ tenantId, bookingId });
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  /**
   * Notes, and the two statuses that record what happened on the day.
   *
   * Cancelling and rescheduling are not reachable from here: both move
   * capacity, and a general-purpose PATCH that could quietly free somebody's
   * appointment is exactly the shape of bug the state machine exists to stop.
   */
  async updateBooking(args: {
    tenantId: string;
    bookingId: string;
    input: UpdateBookingBody;
    audit: AuditContext;
  }): Promise<BookingWithRelations> {
    const { tenantId, bookingId, input } = args;
    const current = await this.repository.findByIdOrThrow({ tenantId, bookingId });

    if (input.status !== undefined) {
      this.enforce(checkTransition(current.status, input.status), TRANSITION_STATUS_MAP);
    }

    await this.prisma.$transaction(async (tx) => {
      await this.repository.updateBooking(tx, {
        tenantId,
        bookingId,
        expectedVersion: input.version ?? current.version,
        data: {
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          ...(input.status === undefined ? {} : { status: input.status }),
        },
      });

      // COMPLETED and NO_SHOW deliberately keep their reservation; only the
      // statuses that free the slot release it.
      if (input.status !== undefined && releasesCapacity(input.status)) {
        await this.repository.releaseBookingReservation(tx, { tenantId, bookingId });
      }

      await this.writeAudit(tx, args.audit, {
        tenantId,
        action: "booking.updated",
        entityId: bookingId,
        before: { status: current.status },
        after: { status: input.status ?? current.status },
      });

      // Accepting a request is the moment the customer has been waiting for, and
      // until now it emitted nothing: they were told we had their request and
      // then never told it was accepted. No token rides along — the raw one
      // existed only when the booking was made — so the confirmation email falls
      // back to pointing at the link they already hold
      // (docs/phase-5-booking-notifications.md §2.1).
      //
      // Nothing else here earns an event. COMPLETED and NO_SHOW record what
      // happened on the day, and cancellation has its own path.
      if (
        current.status === BookingStatuses.PENDING &&
        input.status === BookingStatuses.CONFIRMED
      ) {
        await this.writeOutbox(tx, { tenantId, eventType: "BOOKING_CONFIRMED", bookingId });
      }
    });

    return this.repository.findByIdOrThrow({ tenantId, bookingId });
  }

  // -------------------------------------------------------------------------
  // Shared internals
  // -------------------------------------------------------------------------

  /**
   * Resolve provider, service, location and the policy that governs them.
   *
   * `publicOnly` applies the same predicate the Epic 2 catalogue does, so a
   * provider hidden from the booking page cannot be booked by posting their id
   * directly — the filter is not a UI convenience.
   */
  private async resolvePlan(args: {
    tenantId: string;
    providerId: string;
    serviceId: string;
    locationId?: string | undefined;
    publicOnly: boolean;
    db?: Db;
  }): Promise<BookingPlan> {
    const db = args.db ?? this.prisma;
    const visible = args.publicOnly ? { active: true } : {};

    const service = await db.service.findFirst({
      where: { id: args.serviceId, tenantId: args.tenantId, archivedAt: null, ...visible },
    });
    if (!service) throw serviceNotFound();

    const provider = await db.provider.findFirst({
      where: {
        id: args.providerId,
        tenantId: args.tenantId,
        archivedAt: null,
        ...(args.publicOnly ? { active: true, onlineBookingEnabled: true } : {}),
      },
    });
    if (!provider) throw providerNotFound();

    const location =
      args.locationId === undefined
        ? null
        : await db.location.findFirst({
            where: { id: args.locationId, tenantId: args.tenantId, archivedAt: null, ...visible },
          });
    if (args.locationId !== undefined && !location) throw locationNotFound();

    // An assignment that is inactive at either end is not an offer. Without
    // this a customer could book a provider for a service they do not perform.
    const assignment = await db.providerService.findFirst({
      where: {
        tenantId: args.tenantId,
        providerId: provider.id,
        serviceId: service.id,
        ...(args.publicOnly ? { active: true } : {}),
      },
    });
    if (!assignment) {
      throw new ConflictError(
        ErrorCodes.SLOT_NOT_BOOKABLE,
        "This provider does not offer that service.",
      );
    }

    if (location) {
      const atLocation = await db.providerLocation.findFirst({
        where: {
          tenantId: args.tenantId,
          providerId: provider.id,
          locationId: location.id,
          ...(args.publicOnly ? { active: true } : {}),
        },
      });
      if (!atLocation) {
        throw new ConflictError(
          ErrorCodes.SLOT_NOT_BOOKABLE,
          "This provider does not work at that location.",
        );
      }
    }

    return {
      provider,
      service,
      location,
      durationMinutes: assignment.customDurationMinutes ?? service.durationMinutes,
      bufferBeforeMinutes: service.bufferBeforeMinutes,
      bufferAfterMinutes: service.bufferAfterMinutes,
      minimumNoticeMinutes: mostRestrictiveNotice(
        [provider.minimumNoticeMinutes, service.minimumNoticeMinutes],
        DEFAULT_MINIMUM_NOTICE_MINUTES,
      ),
      maximumAdvanceDays: mostRestrictiveAdvance(
        [provider.maximumAdvanceDays, service.maximumAdvanceDays],
        DEFAULT_MAXIMUM_ADVANCE_DAYS,
      ),
      // The location's zone wins when one is named, matching the slot search.
      timezone: location?.timezone ?? provider.timezone,
    };
  }

  private async planForBooking(
    tenantId: string,
    booking: BookingWithRelations,
  ): Promise<BookingPlan> {
    return this.resolvePlan({
      tenantId,
      providerId: booking.providerId,
      serviceId: booking.serviceId,
      locationId: booking.locationId ?? undefined,
      publicOnly: false,
    });
  }

  /**
   * Is this exact start time one the schedule actually offers?
   *
   * §11.4 steps 3-5 — recurring availability, exceptions, external busy time —
   * and rather than reimplement any of it, this asks the slot search the same
   * question a customer's browser asked and checks the answer contains the
   * requested moment. Two engines computing availability two ways is how a
   * booking page and a booking engine end up disagreeing about a Tuesday.
   *
   * It is not a substitute for the exclusion constraint. This says "the clinic
   * is open then"; the constraint says "nobody else got it first", and only one
   * of those can be answered without a race.
   */
  private async assertSlotIsOffered(args: {
    tenantId: string;
    plan: BookingPlan;
    span: { appointment: { startAt: string; endAt: string } };
    now: Date;
    publicOnly: boolean;
    ignoreNotice?: boolean;
    ignoreBookingId?: string;
  }): Promise<void> {
    const startAt = args.span.appointment.startAt;
    const day = startAt.slice(0, 10);

    // A day either side: a calendar date in the provider's zone is never
    // exactly a UTC date, and the search interprets its range in that zone.
    const dateFrom = shiftDate(day, -1);
    const dateTo = shiftDate(day, 1);

    const slots = await this.availability.searchSlots({
      tenantId: args.tenantId,
      input: {
        serviceId: args.plan.service.id,
        providerId: args.plan.provider.id,
        ...(args.plan.location === null ? {} : { locationId: args.plan.location.id }),
        dateFrom,
        dateTo,
      },
      now: args.now,
      publicOnly: args.publicOnly,
      ...(args.ignoreNotice === true ? { ignoreBookingWindow: true } : {}),
      ...(args.ignoreBookingId === undefined ? {} : { ignoreBookingId: args.ignoreBookingId }),
    });

    const offered = slots.some(
      (slot) =>
        slot.providerId === args.plan.provider.id &&
        Date.parse(slot.startAt) === Date.parse(startAt),
    );

    if (!offered) {
      throw new ConflictError(
        ErrorCodes.SLOT_NOT_BOOKABLE,
        "That time is not available for this service.",
        { startAt },
      );
    }
  }

  /**
   * Find or create the customer. tech-impl §10.11.
   *
   * Matching is on normalised contact details and never on name — see the
   * engine's `customerMatches`. A returning customer who gives a new phone
   * number updates their record; two different people who share a name do not
   * become one.
   */
  private async upsertCustomer(db: Db, tenantId: string, input: CustomerInput): Promise<Customer> {
    const normalizedEmail = input.email === undefined ? null : normalizeEmail(input.email);
    const normalizedPhone =
      input.phone === undefined || normalizePhone(input.phone).length === 0
        ? null
        : normalizePhone(input.phone);

    if (normalizedEmail !== null || normalizedPhone !== null) {
      const candidates = await db.customer.findMany({
        where: {
          tenantId,
          OR: [
            ...(normalizedEmail === null ? [] : [{ normalizedEmail }]),
            ...(normalizedPhone === null ? [] : [{ normalizedPhone }]),
          ],
        },
        take: 10,
      });

      const match = candidates.find((candidate) =>
        customerMatches(candidate, {
          email: input.email ?? null,
          phone: input.phone ?? null,
        }),
      );

      if (match) {
        return db.customer.update({
          where: { id: match.id },
          data: {
            // The name they gave this time wins: people correct spellings and
            // change surnames, and the booking snapshot preserves what each
            // individual appointment was made under regardless.
            fullName: input.fullName.trim(),
            ...(input.email === undefined ? {} : { email: input.email, normalizedEmail }),
            ...(input.phone === undefined ? {} : { phone: input.phone, normalizedPhone }),
            ...(input.preferredLanguage === undefined
              ? {}
              : { preferredLanguage: input.preferredLanguage }),
            ...(input.marketingConsent === undefined
              ? {}
              : { marketingConsent: input.marketingConsent }),
          },
        });
      }
    }

    return db.customer.create({
      data: {
        tenantId,
        fullName: input.fullName.trim(),
        email: input.email ?? null,
        phone: input.phone ?? null,
        normalizedEmail,
        normalizedPhone,
        ...(input.preferredLanguage === undefined
          ? {}
          : { preferredLanguage: input.preferredLanguage }),
        marketingConsent: input.marketingConsent ?? false,
      },
    });
  }

  /**
   * An audit row written with the booking, not alongside it.
   *
   * The audit plugin's own `request.audit()` is fire-and-forget by design, and
   * says so. For booking writes that is the wrong trade: this row and the
   * booking commit together or neither does.
   */
  private async writeAudit(
    db: Db,
    context: AuditContext,
    entry: {
      tenantId: string;
      action: string;
      entityId: string;
      before?: unknown;
      after?: unknown;
    },
  ): Promise<void> {
    const data: Prisma.AuditLogUncheckedCreateInput = {
      tenantId: entry.tenantId,
      actorType: context.actorType,
      actorId: context.actorId,
      action: entry.action,
      entityType: "Booking",
      entityId: entry.entityId,
      // The audit plugin's scrubber drops customer names and contact details;
      // nothing passed here carries them in the first place.
      beforeJson: (entry.before ?? null) as Prisma.InputJsonValue,
      afterJson: (entry.after ?? null) as Prisma.InputJsonValue,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    };

    await db.auditLog.create({ data });
  }

  /**
   * Queue an event without publishing one. tech-impl §12.
   *
   * Nothing here talks to BullMQ, and that is the point: a job published inside
   * a transaction is lost when the transaction rolls back, and a transaction
   * that waits on a queue fails when the queue is down. The worker turns these
   * rows into jobs once it exists (Epic 5); until then they accumulate, which
   * is the correct behaviour rather than a gap.
   *
   * **Ids only, with one exception.** The worker re-reads the booking when the
   * job runs, so an email sent from a retried job reflects the booking as it is
   * now rather than as it was when the event was written. The exception is the
   * management token: it is 32 random bytes stored only as a SHA-256 hash
   * (phase-4 §3.3), so it exists in plaintext for the length of this one request
   * and the worker could not otherwise build a link to the manage page. It rides
   * here exactly as an invitation token does, and `markProcessed` clears the
   * payload once the notification row holds the finished URL
   * (docs/phase-5-booking-notifications.md §2.1).
   */
  private async writeOutbox(
    db: Db,
    args: {
      tenantId: string;
      eventType: string;
      bookingId: string;
      managementToken?: string | undefined;
      /** ISO-8601. Only on a reschedule, where the old time is already gone. */
      previousStartAt?: string | undefined;
    },
  ): Promise<void> {
    await db.outboxEvent.create({
      data: {
        tenantId: args.tenantId,
        eventType: args.eventType,
        aggregateType: "Booking",
        aggregateId: args.bookingId,
        payload: {
          bookingId: args.bookingId,
          ...(args.managementToken === undefined ? {} : { managementToken: args.managementToken }),
          ...(args.previousStartAt === undefined ? {} : { previousStartAt: args.previousStartAt }),
        },
      },
    });
  }

  /** Turn an engine refusal into the HTTP error it deserves. */
  private enforce(
    decision: Decision<string>,
    statuses: Record<string, number> = DEFAULT_STATUS_MAP,
  ): void {
    if (decision.allowed) return;

    const code = REASON_TO_CODE[decision.reason] ?? ErrorCodes.VALIDATION_FAILED;
    const statusCode = statuses[decision.reason] ?? DEFAULT_STATUS_MAP[decision.reason] ?? 422;

    throw new AppError(code, REASON_MESSAGES[decision.reason] ?? "That change is not allowed.", {
      statusCode,
      ...(decision.detail === undefined ? {} : { details: decision.detail }),
    });
  }
}

/**
 * The engine names reasons; HTTP wants codes and statuses. This is the only
 * place the two vocabularies meet, so a new refusal has exactly one place to be
 * mapped and a missing mapping degrades to a 422 rather than a 500.
 */
const REASON_TO_CODE: Record<string, ErrorCode> = {
  HOLD_EXPIRED: ErrorCodes.HOLD_EXPIRED,
  HOLD_RELEASED: ErrorCodes.HOLD_NOT_FOUND,
  HOLD_ALREADY_CONFIRMED: ErrorCodes.HOLD_ALREADY_CONFIRMED,
  MINIMUM_NOTICE_NOT_MET: ErrorCodes.MINIMUM_NOTICE_NOT_MET,
  OUTSIDE_BOOKING_WINDOW: ErrorCodes.OUTSIDE_BOOKING_WINDOW,
  IN_THE_PAST: ErrorCodes.VALIDATION_FAILED,
  SAME_TIME: ErrorCodes.VALIDATION_FAILED,
  ALREADY_STARTED: ErrorCodes.BOOKING_NOT_MODIFIABLE,
  TOO_LATE_TO_CANCEL: ErrorCodes.BOOKING_NOT_MODIFIABLE,
  BOOKING_TERMINAL: ErrorCodes.BOOKING_NOT_MODIFIABLE,
  BOOKING_ALREADY_CANCELLED: ErrorCodes.BOOKING_ALREADY_CANCELLED,
  BOOKING_ALREADY_IN_STATUS: ErrorCodes.BOOKING_NOT_MODIFIABLE,
  ILLEGAL_TRANSITION: ErrorCodes.BOOKING_NOT_MODIFIABLE,
};

const REASON_MESSAGES: Record<string, string> = {
  HOLD_EXPIRED: "Your reservation ran out. Please pick a time again.",
  HOLD_RELEASED: "This reservation no longer exists.",
  HOLD_ALREADY_CONFIRMED: "This reservation has already been booked.",
  MINIMUM_NOTICE_NOT_MET: "That time is too soon to book.",
  OUTSIDE_BOOKING_WINDOW: "That date is further ahead than bookings are accepted.",
  IN_THE_PAST: "That time has already passed.",
  SAME_TIME: "The new time is the same as the current one.",
  ALREADY_STARTED: "This appointment has already started.",
  TOO_LATE_TO_CANCEL: "It is too late to change this appointment.",
  BOOKING_TERMINAL: "This appointment is already finished and cannot be changed.",
  BOOKING_ALREADY_CANCELLED: "This appointment is already cancelled.",
  BOOKING_ALREADY_IN_STATUS: "This appointment is already in that state.",
  ILLEGAL_TRANSITION: "That is not a change this appointment can make.",
};

const DEFAULT_STATUS_MAP: Record<string, number> = {
  HOLD_EXPIRED: 409,
  HOLD_RELEASED: 404,
  HOLD_ALREADY_CONFIRMED: 409,
  MINIMUM_NOTICE_NOT_MET: 422,
  OUTSIDE_BOOKING_WINDOW: 422,
  IN_THE_PAST: 422,
  SAME_TIME: 422,
  ALREADY_STARTED: 409,
  TOO_LATE_TO_CANCEL: 409,
  BOOKING_TERMINAL: 409,
  BOOKING_ALREADY_CANCELLED: 409,
  BOOKING_ALREADY_IN_STATUS: 409,
  ILLEGAL_TRANSITION: 409,
};

const RESCHEDULE_STATUS_MAP = DEFAULT_STATUS_MAP;
const CANCELLATION_STATUS_MAP = DEFAULT_STATUS_MAP;
const TRANSITION_STATUS_MAP = DEFAULT_STATUS_MAP;

/** `YYYY-MM-DD` plus or minus whole days, with no zone involved. */
function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export type { BookingPlan, Booking, BookingStatus };
