import { describe, expect, it } from "vitest";
import {
  AppError,
  ConflictError,
  ErrorCodes,
  ForbiddenError,
  InternalError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
  isAppError,
} from "./index.js";

describe("AppError", () => {
  it("defaults `report` from the status code", () => {
    expect(new ValidationError().report).toBe(false);
    expect(new NotFoundError().report).toBe(false);
    expect(new ForbiddenError().report).toBe(false);
    expect(new InternalError().report).toBe(true);
  });

  it("lets `report` be overridden explicitly", () => {
    const error = new AppError(ErrorCodes.INTERNAL_ERROR, "expected", {
      statusCode: 500,
      report: false,
    });
    expect(error.report).toBe(false);
  });

  it("maps concrete errors to the agreed status codes", () => {
    expect(new ValidationError().statusCode).toBe(422);
    expect(new NotFoundError().statusCode).toBe(404);
    expect(new ForbiddenError().statusCode).toBe(403);
    expect(new ConflictError(ErrorCodes.SLOT_NO_LONGER_AVAILABLE, "taken").statusCode).toBe(409);
    expect(new RateLimitedError().statusCode).toBe(429);
  });

  it("omits `details` from the payload when unset rather than emitting undefined", () => {
    expect(new NotFoundError().toPayload()).toEqual({
      code: ErrorCodes.NOT_FOUND,
      message: "The requested resource does not exist.",
    });
  });

  it("includes `details` when provided", () => {
    const error = new ConflictError(ErrorCodes.SLOT_NO_LONGER_AVAILABLE, "taken", {
      providerId: "provider_1",
    });
    expect(error.toPayload()).toMatchObject({ details: { providerId: "provider_1" } });
  });

  it("preserves the cause chain", () => {
    const cause = new Error("socket hang up");
    expect(new InternalError("upstream failed", cause).cause).toBe(cause);
  });
});

describe("isAppError", () => {
  it("recognises AppError instances and subclasses", () => {
    expect(isAppError(new InternalError())).toBe(true);
    expect(isAppError(new ValidationError())).toBe(true);
  });

  it("rejects plain errors and non-errors", () => {
    expect(isAppError(new Error("nope"))).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
    expect(isAppError("VALIDATION_FAILED")).toBe(false);
    expect(isAppError({ code: "NOT_FOUND" })).toBe(false);
  });

  it("recognises a structurally identical error from another module copy", () => {
    // Simulates the bundle-boundary case the duck-typed marker exists for:
    // a second copy of the class means `instanceof` would fail here.
    const fromOtherBundle = Object.assign(new Error("duplicate module"), {
      __isAppError: true,
      code: ErrorCodes.NOT_FOUND,
      statusCode: 404,
      report: false,
    });

    expect(isAppError(fromOtherBundle)).toBe(true);
    expect(fromOtherBundle instanceof AppError).toBe(false);
  });
});
