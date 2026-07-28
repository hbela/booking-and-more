import { ErrorCodes, type ErrorCode } from "./error-codes.js";

/** Extra machine-readable context. Must be JSON-serialisable and free of PII. */
export type ErrorDetails = Record<string, unknown>;

/**
 * Marker property used instead of `instanceof`.
 *
 * `instanceof` breaks when a module is duplicated across bundle boundaries — two
 * copies of the class mean two distinct prototypes, and errors thrown by one are
 * unrecognised by the other. A duck-typed flag survives that. Lifted from
 * booking-for-all's `AppError`, which is the one part of its error handling that
 * was unambiguously right.
 */
const APP_ERROR_MARKER = "__isAppError" as const;

export interface AppErrorShape {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly message: string;
  readonly details?: ErrorDetails;
  /** False for the 4xx family — expected, not worth paging anyone over. */
  readonly report: boolean;
}

/**
 * Base class for every error the API deliberately returns.
 *
 * Anything that is *not* an AppError reaching the error handler is treated as a
 * bug: logged at error level, reported to Sentry, and returned as a bare 500
 * with no internal detail leaked.
 */
export class AppError extends Error implements AppErrorShape {
  public readonly [APP_ERROR_MARKER] = true as const;
  public override readonly name: string = "AppError";
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: ErrorDetails;
  public readonly report: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      statusCode?: number;
      details?: ErrorDetails;
      cause?: unknown;
      /** Defaults to true only for 5xx. */
      report?: boolean;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });

    const statusCode = options.statusCode ?? 500;
    this.code = code;
    this.statusCode = statusCode;
    this.report = options.report ?? statusCode >= 500;
    if (options.details !== undefined) {
      this.details = options.details;
    }

    Error.captureStackTrace?.(this, new.target);
  }

  /** The `error` member of the response envelope. `requestId` is added by the handler. */
  toPayload(): Omit<ErrorEnvelope["error"], "requestId"> {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

/** Structural check — see {@link APP_ERROR_MARKER} for why this is not `instanceof`. */
export function isAppError(error: unknown): error is AppError {
  return (
    typeof error === "object" &&
    error !== null &&
    APP_ERROR_MARKER in error &&
    (error as Record<string, unknown>)[APP_ERROR_MARKER] === true
  );
}

/** The wire format of every error response (tech-impl §15.1). */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: ErrorDetails;
  };
}

// ---------------------------------------------------------------------------
// Concrete errors
//
// Constructing these rather than raw AppErrors keeps status codes consistent
// across modules — the predecessor project returned 400, 404 and 409 for the
// same logical condition in different handlers.
// ---------------------------------------------------------------------------

export class ValidationError extends AppError {
  public override readonly name = "ValidationError";
  constructor(message = "The request payload is invalid.", details?: ErrorDetails) {
    super(ErrorCodes.VALIDATION_FAILED, message, { statusCode: 422, ...(details && { details }) });
  }
}

export class NotFoundError extends AppError {
  public override readonly name = "NotFoundError";
  constructor(
    message = "The requested resource does not exist.",
    code: ErrorCode = ErrorCodes.NOT_FOUND,
    details?: ErrorDetails,
  ) {
    super(code, message, { statusCode: 404, ...(details && { details }) });
  }
}

export class UnauthenticatedError extends AppError {
  public override readonly name = "UnauthenticatedError";
  constructor(message = "Authentication is required.") {
    super(ErrorCodes.UNAUTHENTICATED, message, { statusCode: 401 });
  }
}

export class ForbiddenError extends AppError {
  public override readonly name = "ForbiddenError";
  constructor(message = "You do not have permission to perform this action.") {
    super(ErrorCodes.FORBIDDEN, message, { statusCode: 403 });
  }
}

export class ConflictError extends AppError {
  public override readonly name = "ConflictError";
  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super(code, message, { statusCode: 409, ...(details && { details }) });
  }
}

export class RateLimitedError extends AppError {
  public override readonly name = "RateLimitedError";
  constructor(
    message = "Too many requests. Please try again shortly.",
    retryAfterSeconds?: number,
  ) {
    super(ErrorCodes.RATE_LIMITED, message, {
      statusCode: 429,
      ...(retryAfterSeconds === undefined ? {} : { details: { retryAfterSeconds } }),
    });
  }
}

export class ServiceUnavailableError extends AppError {
  public override readonly name = "ServiceUnavailableError";
  constructor(message = "The service is temporarily unavailable.", details?: ErrorDetails) {
    super(ErrorCodes.SERVICE_UNAVAILABLE, message, {
      statusCode: 503,
      ...(details && { details }),
    });
  }
}

export class InternalError extends AppError {
  public override readonly name = "InternalError";
  constructor(message = "An unexpected error occurred.", cause?: unknown) {
    super(ErrorCodes.INTERNAL_ERROR, message, { statusCode: 500, cause });
  }
}
