import { describe, expect, it } from "vitest";
import { scrubTelemetry } from "./sentry-scrubbing.js";

describe("Sentry privacy filtering", () => {
  it("removes request content and user details while preserving diagnostic IDs", () => {
    const event = {
      user: { id: "user-1", email: "owner@example.com", username: "Owner" },
      request: { headers: { authorization: "Bearer secret" }, data: { name: "Patient" } },
      tags: { requestId: "request-1" },
      breadcrumbs: [{ data: { phone: "+3612345678" }, message: "Failed for a@example.com" }],
    };
    const result = scrubTelemetry(event);
    expect(result.user).toEqual({ id: "user-1" });
    expect(result.request).toEqual({ headers: {}, data: {} });
    expect(result.tags).toEqual({ requestId: "request-1" });
    expect(JSON.stringify(result)).not.toMatch(/Patient|Bearer|example\.com|3612345678/);
    expect(event.request.data.name).toBe("Patient");
  });

  it("redacts booking, invitation, and query credentials in exception messages", () => {
    const message =
      "/v1/public/bookings/booking-secret /invitations/invite-secret?token=query-secret";
    expect(scrubTelemetry({ exception: { values: [{ value: message }] } })).toEqual({
      exception: {
        values: [
          { value: "/v1/public/bookings/[REDACTED] /invitations/[REDACTED]?token=[REDACTED]" },
        ],
      },
    });
  });

  it("covers localized browser booking links and standalone query strings", () => {
    expect(scrubTelemetry("https://app.example/hu/booking/manage/private-token")).toBe(
      "https://app.example/hu/booking/manage/[REDACTED]",
    );
    expect(scrubTelemetry("token=private-token&lang=hu")).toBe("token=[REDACTED]&lang=hu");
  });

  it("survives circular references instead of overflowing the stack", () => {
    const span: Record<string, unknown> = { op: "http.client" };
    const spans: unknown[] = [span];
    span.siblings = spans;
    const event: Record<string, unknown> = { spans, email: "a@example.com" };
    event.self = event;

    const result = scrubTelemetry(event);
    expect(result.self).toBe("[Circular]");
    expect(result.email).toBe("[REDACTED]");
    expect(result.spans).toEqual([{ op: "http.client", siblings: "[Circular]" }]);
  });

  it("scrubs a shared, non-circular reference at every place it appears", () => {
    const shared = { message: "Failed for a@example.com" };
    expect(scrubTelemetry({ first: shared, second: shared })).toEqual({
      first: { message: "Failed for [REDACTED_EMAIL]" },
      second: { message: "Failed for [REDACTED_EMAIL]" },
    });
  });

  it("truncates pathologically deep payloads", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 10_000; i += 1) deep = deep.next = {};
    expect(() => scrubTelemetry(root)).not.toThrow();
    expect(JSON.stringify(scrubTelemetry(root))).toContain("[Truncated]");
  });
});
