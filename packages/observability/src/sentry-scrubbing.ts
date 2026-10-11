/** Browser-safe telemetry filtering; never imports the Node SDK or runtime config. */
export function scrubTelemetry<T>(event: T): T {
  return scrub(event, new Set(), 0) as T;
}

/**
 * Deeper than any real event; a bound so a pathological payload cannot exhaust
 * the stack. Sentry hands hooks live SDK objects (http breadcrumbs, transaction
 * spans) that can be self-referential, and an unbounded walk once overflowed on
 * every event — 10K `RangeError`s in a day, each one itself reported.
 */
const MAX_DEPTH = 32;

/**
 * `ancestors` holds only the current path, not everything seen: an object
 * referenced twice from siblings is shared, not circular, and is scrubbed at
 * both places.
 */
function scrub(value: unknown, ancestors: Set<object>, depth: number): unknown {
  if (typeof value === "string") {
    return value
      .replace(
        /(\/(?:v1\/public\/bookings|booking\/manage|invitations)\/)[^/?#\s]+/gu,
        "$1[REDACTED]",
      )
      .replace(/((?:^|[?&])(?:token|code|email|password|secret|key)=)[^&#\s]*/giu, "$1[REDACTED]")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[REDACTED_EMAIL]");
  }
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  ancestors.add(value);
  try {
    return scrubContainer(value, ancestors, depth + 1);
  } finally {
    ancestors.delete(value);
  }
}

function scrubContainer(value: object, ancestors: Set<object>, depth: number): unknown {
  if (Array.isArray(value)) return value.map((item) => scrub(item, ancestors, depth));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (/^(?:headers|cookies|data)$/iu.test(key)) return [key, {}];
      if (
        /^(?:headers|cookies|body|data|email|phone|fullName|customerName|customerEmail|customerPhone|password|token|secret|authorization|ip_address)$/iu.test(
          key,
        )
      )
        return [key, "[REDACTED]"];
      if (key === "user") {
        const user = item as { id?: unknown } | null;
        return [key, typeof user?.id === "string" ? { id: user.id } : {}];
      }
      return [key, scrub(item, ancestors, depth)];
    }),
  );
}
