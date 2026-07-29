/**
 * @bam/booking-engine — the booking domain's decisions, as functions.
 * tech-impl §11, §14.
 *
 * Like @bam/availability-engine, this package has **no runtime dependencies**
 * and imports no Fastify, Prisma, Redis or HTTP client (CLAUDE.md rule 8).
 *
 * ## What is here and what is not
 *
 * tech-impl §14 sketches a `BookingEngine` whose methods return Promises —
 * `createHold`, `confirmBooking`, `confirmReschedule`. Those are transactions,
 * and a transaction cannot be pure: acquiring capacity is precisely the part
 * that has to happen in PostgreSQL, where the exclusion constraint lives
 * (§11.2, §11.3). Splitting them would produce a package that imports Prisma
 * and a rule that means nothing.
 *
 * So the split follows the one Epic 3 already established between
 * AvailabilityService and @bam/availability-engine: **the API owns the
 * transaction, this package owns the decisions**. Whether a hold is still
 * usable, whether a status may change, whether a booking is inside its window,
 * how wide a diary block an appointment carves out, what a booking records
 * about the world — all decidable from values, all testable without a database.
 *
 * What is genuinely a race — two customers confirming the same slot — is not
 * decided here at all. It is decided by the database refusing the second
 * INSERT, because that is the only place the answer can be correct.
 *
 * ## Decisions, not exceptions
 *
 * Every `check*` returns a {@link Decision} rather than throwing. The engine has
 * no opinion about HTTP status codes, and a caller branching on *why* something
 * was refused should not have to catch and re-inspect an error.
 */

export {
  checkHoldReleasable,
  checkHoldUsable,
  DEFAULT_HOLD_DURATION_MINUTES,
  effectiveHoldStatus,
  holdExpiresAt,
  holdRemainingSeconds,
} from "./holds.js";
export type { HoldRefusal } from "./holds.js";

export {
  checkBookingWindow,
  checkCancellable,
  checkReschedulable,
  mostRestrictiveAdvance,
  mostRestrictiveNotice,
} from "./policy.js";
export type { BookingWindowRefusal, CancellationRefusal, RescheduleRefusal } from "./policy.js";

export {
  durationMinutesOf,
  isPositiveSpan,
  occupiedSpanFor,
  parseInstant,
  spansOverlap,
  toInstant,
} from "./spans.js";

export {
  buildBookingSnapshot,
  customerMatches,
  normalizeEmail,
  normalizePhone,
} from "./snapshots.js";
export type { BookingSnapshot } from "./snapshots.js";

export {
  allowedTransitionsFrom,
  checkTransition,
  initialBookingStatus,
  isBlocking,
  isTerminal,
  releasesCapacity,
} from "./transitions.js";
export type { TransitionRefusal } from "./transitions.js";

export {
  BLOCKING_BOOKING_STATUSES,
  BookingSources,
  BookingStatuses,
  HoldStatuses,
  ReservationStatuses,
} from "./types.js";
export type {
  BookingSource,
  BookingStatus,
  Decision,
  HoldStatus,
  OccupiedSpan,
  ReservationStatus,
  Span,
} from "./types.js";
