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

  /**
   * The week was saved by somebody else since the caller read it.
   *
   * The working-hours `PUT` replaces the whole set, so a body built from a stale
   * read silently reverts whatever landed in between — and diary delegation made
   * a second editor the *expected* arrangement rather than a rarity
   * (docs/phase-3-4-diary-delegation.md §2.14). `details` carries
   * `currentFingerprint` and `lastChange`, so the screen can say **who** moved it
   * rather than only that somebody did.
   *
   * Deliberately not the same code as `SCHEDULE_CONFLICTS_BOOKINGS`, which is
   * also a 409 on this route: that one is "your change costs these appointments,
   * confirm it", and re-sending with an acknowledgement is right. This one is
   * "you are about to undo work you have not seen", and re-sending the same body
   * is exactly wrong — the caller has to look first.
   */
  SCHEDULE_MODIFIED: "SCHEDULE_MODIFIED",

  /**
   * A whole-set schedule write arrived without saying which version it replaces.
   *
   * Its own code rather than a generic 422, for the reason
   * `IDEMPOTENCY_KEY_REQUIRED` is: "you did not read before writing" is a
   * different fix from "your body is malformed", and phase-2-3 §2's rule — a
   * whole-set body may only be built from a whole-set read — is the thing being
   * enforced. Optional in the Zod schema so that authorization still answers
   * first; refused in the handler.
   */
  SCHEDULE_FINGERPRINT_REQUIRED: "SCHEDULE_FINGERPRINT_REQUIRED",

  // --- Diary delegation -----------------------------------------------------
  /**
   * The member named cannot receive this diary: they are not ACTIVE, their role
   * holds no delegated permission, or the diary is already theirs.
   *
   * Distinct from `FORBIDDEN`, because they are about different people.
   * `FORBIDDEN` says the *caller* may not; this says the person they named
   * cannot receive it. A screen that cannot tell them apart sends the wrong
   * person off to ask for permission.
   * docs/phase-3-4-diary-delegation.md §5.2.
   */
  DELEGATION_TARGET_INELIGIBLE: "DELEGATION_TARGET_INELIGIBLE",

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
