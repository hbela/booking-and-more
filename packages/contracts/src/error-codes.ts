/**
 * Every error code the API can return.
 *
 * Codes are the stable, machine-readable part of the error contract — clients
 * branch on these, messages are for humans and may be localised or reworded.
 * Adding a code is cheap; changing or removing one is a breaking API change.
 *
 * tech-impl §15.1.
 */
export const ErrorCodes = {
  // --- Generic --------------------------------------------------------------
  INTERNAL_ERROR: "INTERNAL_ERROR",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  NOT_FOUND: "NOT_FOUND",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  RATE_LIMITED: "RATE_LIMITED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",

  // --- Auth / tenancy (Epic 1) ---------------------------------------------
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  TENANT_NOT_FOUND: "TENANT_NOT_FOUND",
  TENANT_SUSPENDED: "TENANT_SUSPENDED",

  // --- Catalogue (Epic 2) ---------------------------------------------------
  PROVIDER_NOT_FOUND: "PROVIDER_NOT_FOUND",
  SERVICE_NOT_FOUND: "SERVICE_NOT_FOUND",
  LOCATION_NOT_FOUND: "LOCATION_NOT_FOUND",
  /** A slug already in use within the tenant. Slugs are public URLs. */
  SLUG_TAKEN: "SLUG_TAKEN",

  // --- Idempotency (tech-impl §32) -----------------------------------------
  IDEMPOTENCY_KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  /** The first request carrying this key has not finished yet. */
  IDEMPOTENCY_KEY_IN_PROGRESS: "IDEMPOTENCY_KEY_IN_PROGRESS",

  // --- Booking (Epic 4) -----------------------------------------------------
  /** The exclusion constraint refused: somebody else got there first. */
  SLOT_NO_LONGER_AVAILABLE: "SLOT_NO_LONGER_AVAILABLE",
  /** Nothing in the schedule offers this time — closed, blocked, or not on the
   *  slot grid. Distinct from SLOT_NO_LONGER_AVAILABLE, which means "taken". */
  SLOT_NOT_BOOKABLE: "SLOT_NOT_BOOKABLE",
  HOLD_EXPIRED: "HOLD_EXPIRED",
  HOLD_NOT_FOUND: "HOLD_NOT_FOUND",
  /** The hold already became a booking — retrying must not make a second one. */
  HOLD_ALREADY_CONFIRMED: "HOLD_ALREADY_CONFIRMED",
  BOOKING_NOT_FOUND: "BOOKING_NOT_FOUND",
  BOOKING_ALREADY_CANCELLED: "BOOKING_ALREADY_CANCELLED",
  /** Finished, started, or past its cancellation deadline. */
  BOOKING_NOT_MODIFIABLE: "BOOKING_NOT_MODIFIABLE",
  OUTSIDE_BOOKING_WINDOW: "OUTSIDE_BOOKING_WINDOW",
  MINIMUM_NOTICE_NOT_MET: "MINIMUM_NOTICE_NOT_MET",

  // --- Availability (Epic 3) ------------------------------------------------
  /**
   * A schedule change would leave existing bookings outside it.
   *
   * Not a refusal — the same request succeeds carrying
   * `acknowledgeAffectedBookings`. It is returned once so the list of what would
   * be stranded reaches the caller before the change lands
   * (docs/phase-3-4-schedule-conflicts.md §2.4). `details.affectedBookings`
   * carries them.
   */
  SCHEDULE_CONFLICTS_BOOKINGS: "SCHEDULE_CONFLICTS_BOOKINGS",

  // --- Calendar integrations (Epic 6) --------------------------------------
  /**
   * The connection exists but cannot do work: disconnected, or waiting for a
   * human to re-consent after Google withdrew the grant.
   *
   * Distinct from `SERVICE_UNAVAILABLE`, which means the *platform* has no
   * Google credentials at all. One is fixed by the provider clicking reconnect
   * and the other by an operator editing an environment file, so a screen that
   * cannot tell them apart gives the wrong instruction to whoever is reading it.
   */
  CALENDAR_INTEGRATION_INACTIVE: "CALENDAR_INTEGRATION_INACTIVE",

  // --- Conversational (Epics 7-8) ------------------------------------------
  PENDING_ACTION_NOT_FOUND: "PENDING_ACTION_NOT_FOUND",
  PENDING_ACTION_EXPIRED: "PENDING_ACTION_EXPIRED",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  USAGE_QUOTA_EXCEEDED: "USAGE_QUOTA_EXCEEDED",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
