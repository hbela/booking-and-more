/**
 * The booking domain's vocabulary. tech-impl §10.12, §10.13, §11, §14.
 *
 * Instants are ISO 8601 strings at the boundary, exactly as in
 * @bam/availability-engine, and epoch milliseconds inside. Strings are what a
 * database row and an HTTP body both already hold; converting once at the edge
 * beats threading `Date` objects through decision logic that never wants one.
 */

/** PRD §9.9. */
export const BookingStatuses = {
  /** Created but awaiting staff acceptance — `Service.requiresApproval`. */
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  CANCELLED: "CANCELLED",
  COMPLETED: "COMPLETED",
  NO_SHOW: "NO_SHOW",
  /** A PENDING booking nobody acted on before its start time passed. */
  EXPIRED: "EXPIRED",
} as const;

export type BookingStatus = (typeof BookingStatuses)[keyof typeof BookingStatuses];

/**
 * Statuses that occupy the diary.
 *
 * This set is the single definition of "this time is taken", and it must agree
 * with the exclusion constraint's `WHERE` clause in the migration. They are
 * written in two languages — TypeScript here, SQL there — and a disagreement
 * between them is either a double booking or a slot nobody can ever book, so
 * {@link BLOCKING_BOOKING_STATUSES} exists to be asserted against in a test.
 */
export const BLOCKING_BOOKING_STATUSES: readonly BookingStatus[] = [
  BookingStatuses.PENDING,
  BookingStatuses.CONFIRMED,
];

/** tech-impl §10.12. */
export const HoldStatuses = {
  ACTIVE: "ACTIVE",
  /** Became a booking. Terminal. */
  CONFIRMED: "CONFIRMED",
  /** Given up deliberately — the customer went back a step. Terminal. */
  RELEASED: "RELEASED",
  /** Ran out of time. Terminal. */
  EXPIRED: "EXPIRED",
} as const;

export type HoldStatus = (typeof HoldStatuses)[keyof typeof HoldStatuses];

/**
 * tech-impl §11.3.
 *
 * Only two, and deliberately: a reservation either blocks the slot or it does
 * not. A confirmed booking's reservation stays ACTIVE — it is still occupying
 * the diary, and the only thing that changed is which row now owns it.
 */
export const ReservationStatuses = {
  ACTIVE: "ACTIVE",
  RELEASED: "RELEASED",
} as const;

export type ReservationStatus = (typeof ReservationStatuses)[keyof typeof ReservationStatuses];

/** tech-impl §10.13. Where the booking came from, for reporting and audit. */
export const BookingSources = {
  FORM: "FORM",
  CHAT: "CHAT",
  VOICE: "VOICE",
  STAFF: "STAFF",
  API: "API",
} as const;

export type BookingSource = (typeof BookingSources)[keyof typeof BookingSources];

// ---------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------

/** An absolute half-open span `[startAt, endAt)`. Both ends are ISO instants. */
export interface Span {
  startAt: string;
  endAt: string;
}

/**
 * What an appointment occupies versus what the customer is told.
 *
 * The distinction is the whole reason this type exists. A customer books
 * 10:00–10:45; the diary loses 09:50–10:55 because the service carries a
 * ten-minute before-buffer and a ten-minute after-buffer. The first pair is
 * what appears in a confirmation email, the second is what the capacity
 * reservation stores and what the next availability search subtracts.
 */
export interface OccupiedSpan {
  /** What the customer sees, and what `bookings.start_at` stores. */
  appointment: Span;
  /** What the diary loses, and what `capacity_reservations` stores. */
  occupied: Span;
}

// ---------------------------------------------------------------------------
// Decision results
//
// Every check in this package returns a result rather than throwing. The engine
// has no opinion about HTTP status codes, and a caller that wants to branch on
// *why* something was refused should not have to catch and re-inspect. The API
// layer maps these reasons onto AppError subclasses.
// ---------------------------------------------------------------------------

export type Decision<TReason extends string> =
  { allowed: true } | { allowed: false; reason: TReason; detail?: Record<string, unknown> };

export const ALLOWED: Decision<never> = { allowed: true };

export function refuse<TReason extends string>(
  reason: TReason,
  detail?: Record<string, unknown>,
): Decision<TReason> {
  return detail === undefined ? { allowed: false, reason } : { allowed: false, reason, detail };
}
