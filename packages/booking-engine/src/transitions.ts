import {
  ALLOWED,
  BLOCKING_BOOKING_STATUSES,
  BookingStatuses,
  refuse,
  type BookingStatus,
  type Decision,
} from "./types.js";

/**
 * The booking state machine. PRD §9.9.
 *
 * ## Terminal means terminal
 *
 * CANCELLED, COMPLETED, NO_SHOW and EXPIRED lead nowhere. That is stricter than
 * it first looks — staff cannot un-cancel — and it is deliberate.
 *
 * Cancelling releases the capacity reservation, so the slot goes back on sale
 * the instant the transaction commits. By the time somebody wants the booking
 * back, the time may belong to another customer, and a state machine cannot
 * promise otherwise: reinstating a booking means *acquiring capacity again*,
 * which can fail. Making that look like a status change would hide a conflict
 * that has to be handled. So reinstatement is a new booking, and the audit log
 * carries the relationship.
 *
 * The predecessor project allowed CANCELLED → CONFIRMED and produced exactly
 * the expected result: two confirmed bookings in one slot, neither of them
 * wrong according to the code that made them.
 */
const LEGAL_TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  // Awaiting staff acceptance (`Service.requiresApproval`).
  [BookingStatuses.PENDING]: [
    BookingStatuses.CONFIRMED,
    BookingStatuses.CANCELLED,
    BookingStatuses.EXPIRED,
  ],
  [BookingStatuses.CONFIRMED]: [
    BookingStatuses.CANCELLED,
    BookingStatuses.COMPLETED,
    BookingStatuses.NO_SHOW,
  ],
  [BookingStatuses.CANCELLED]: [],
  [BookingStatuses.COMPLETED]: [],
  [BookingStatuses.NO_SHOW]: [],
  [BookingStatuses.EXPIRED]: [],
};

export function isTerminal(status: BookingStatus): boolean {
  return LEGAL_TRANSITIONS[status].length === 0;
}

/** Whether a booking in this status occupies the diary. */
export function isBlocking(status: BookingStatus): boolean {
  return BLOCKING_BOOKING_STATUSES.includes(status);
}

/**
 * Whether arriving at this status frees the slot.
 *
 * COMPLETED and NO_SHOW deliberately do not: the appointment happened, or the
 * time was set aside and wasted. Leaving the reservation in place also stops a
 * second booking being written over a past one by a careless backfill.
 */
export function releasesCapacity(status: BookingStatus): boolean {
  return status === BookingStatuses.CANCELLED || status === BookingStatuses.EXPIRED;
}

export type TransitionRefusal =
  | "BOOKING_ALREADY_CANCELLED"
  | "BOOKING_ALREADY_IN_STATUS"
  | "BOOKING_TERMINAL"
  | "ILLEGAL_TRANSITION";

/**
 * May this booking move from `from` to `to`?
 *
 * A no-op transition is separated out because a retried cancellation is a
 * different conversation from an impossible one: the caller usually wants to
 * treat "already cancelled" as success, and cannot do that if it arrives
 * indistinguishable from "you cannot cancel a completed appointment".
 */
export function checkTransition(
  from: BookingStatus,
  to: BookingStatus,
): Decision<TransitionRefusal> {
  if (from === to) {
    return from === BookingStatuses.CANCELLED
      ? refuse("BOOKING_ALREADY_CANCELLED")
      : refuse("BOOKING_ALREADY_IN_STATUS", { status: from });
  }

  if (isTerminal(from)) {
    return from === BookingStatuses.CANCELLED
      ? refuse("BOOKING_ALREADY_CANCELLED")
      : refuse("BOOKING_TERMINAL", { status: from });
  }

  return LEGAL_TRANSITIONS[from].includes(to)
    ? ALLOWED
    : refuse("ILLEGAL_TRANSITION", { from, to });
}

/**
 * What a freshly confirmed booking starts as.
 *
 * `Service.requiresApproval` asks for a staff decision, unless the owner has
 * opted this provider's whole diary into automatic confirmation. A PENDING
 * booking still holds its capacity reservation — the customer asked first,
 * and staff deciding slowly must not cost them the slot.
 */
export function initialBookingStatus(
  service: { requiresApproval: boolean },
  provider: { autoConfirmBookings: boolean },
): BookingStatus {
  return service.requiresApproval && !provider.autoConfirmBookings
    ? BookingStatuses.PENDING
    : BookingStatuses.CONFIRMED;
}

/** Every status reachable from `from`, for building a staff UI's action list. */
export function allowedTransitionsFrom(from: BookingStatus): readonly BookingStatus[] {
  return LEGAL_TRANSITIONS[from];
}
