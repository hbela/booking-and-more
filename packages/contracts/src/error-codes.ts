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

  // --- Conversational (Epics 7-8) ------------------------------------------
  PENDING_ACTION_NOT_FOUND: "PENDING_ACTION_NOT_FOUND",
  PENDING_ACTION_EXPIRED: "PENDING_ACTION_EXPIRED",
  /** Already confirmed or cancelled. A second "yes" must not book twice. */
  PENDING_ACTION_ALREADY_USED: "PENDING_ACTION_ALREADY_USED",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  USAGE_QUOTA_EXCEEDED: "USAGE_QUOTA_EXCEEDED",
  /** Unknown id, wrong token, expired session, another tenant's conversation —
   *  all of them. The endpoint must not be an oracle for which ids are real. */
  CONVERSATION_NOT_FOUND: "CONVERSATION_NOT_FOUND",
  /** No AI provider is configured. One feature degrades; forms still book. */
  CONVERSATION_UNAVAILABLE: "CONVERSATION_UNAVAILABLE",
  /** PRD §11's max-turns control. The form is still there. */
  CONVERSATION_TURN_LIMIT_REACHED: "CONVERSATION_TURN_LIMIT_REACHED",
  /** The upload is not audio we accept, or claims to be and is not. */
  AUDIO_FORMAT_UNSUPPORTED: "AUDIO_FORMAT_UNSUPPORTED",
  /** Longer than VOICE_MAX_DURATION_SECONDS, or larger than the byte cap. */
  AUDIO_TOO_LARGE: "AUDIO_TOO_LARGE",
  /** The provider was reached and did not produce a transcript. */
  TRANSCRIPTION_FAILED: "TRANSCRIPTION_FAILED",
  /** The model answered and the envelope failed validation (tech-impl §21). */
  INTERPRETATION_FAILED: "INTERPRETATION_FAILED",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
