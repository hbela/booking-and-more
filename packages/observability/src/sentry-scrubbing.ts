/** Browser-safe telemetry filtering; never imports the Node SDK or runtime config. */
export function scrubTelemetry<T>(event: T): T {
  return scrub(event) as T;
}

function scrub(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(
        /(\/(?:v1\/public\/bookings|booking\/manage|invitations)\/)[^/?#\s]+/gu,
        "$1[REDACTED]",
      )
      .replace(/((?:^|[?&])(?:token|code|email|password|secret|key)=)[^&#\s]*/giu, "$1[REDACTED]")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[REDACTED_EMAIL]");
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value !== "object" || value === null) return value;
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
      return [key, scrub(item)];
    }),
  );
}
