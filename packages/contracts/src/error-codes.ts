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

  // --- Idempotency (tech-impl §32) -----------------------------------------
  IDEMPOTENCY_KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",

  // --- Booking (Epic 4) -----------------------------------------------------
  SLOT_NO_LONGER_AVAILABLE: "SLOT_NO_LONGER_AVAILABLE",
  HOLD_EXPIRED: "HOLD_EXPIRED",
  HOLD_NOT_FOUND: "HOLD_NOT_FOUND",
  BOOKING_NOT_FOUND: "BOOKING_NOT_FOUND",
  BOOKING_ALREADY_CANCELLED: "BOOKING_ALREADY_CANCELLED",
  OUTSIDE_BOOKING_WINDOW: "OUTSIDE_BOOKING_WINDOW",
  MINIMUM_NOTICE_NOT_MET: "MINIMUM_NOTICE_NOT_MET",

  // --- Conversational (Epics 7-8) ------------------------------------------
  PENDING_ACTION_NOT_FOUND: "PENDING_ACTION_NOT_FOUND",
  PENDING_ACTION_EXPIRED: "PENDING_ACTION_EXPIRED",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  USAGE_QUOTA_EXCEEDED: "USAGE_QUOTA_EXCEEDED",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
