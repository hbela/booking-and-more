import { REDACTED } from "./redaction.js";

/**
 * Booking-management links carry their bearer credential in the path. Keep
 * the route shape useful for operations while ensuring no logger, error, or
 * telemetry string can retain the credential itself.
 */
const MANAGEMENT_TOKEN_IN_PATH = /(\/v1\/public\/bookings\/)([^/?#\s]+)/gu;

export function redactSecretBearingUrls(value: string): string {
  return value.replace(MANAGEMENT_TOKEN_IN_PATH, `$1${REDACTED}`);
}

/** Sentry events are already plain data; sanitize every string so a URL hidden
 * in an exception value, stack frame, breadcrumb, or request field is covered. */
export function redactSecretBearingValues<T>(value: T): T {
  return redactUnknown(value) as T;
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecretBearingUrls(value);
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => redactUnknown(item));
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactUnknown(item),
      ]),
    );
  }
  return value;
}
