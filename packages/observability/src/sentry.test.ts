import { beforeEach, describe, expect, it, vi } from "vitest";

const captureCheckIn = vi.fn();
vi.mock("@sentry/node", () => ({ init: vi.fn(), captureCheckIn }));

// Fresh module per test: `initialised` is module state.
async function load() {
  vi.resetModules();
  return import("./sentry.js");
}

describe("reportHeartbeat", () => {
  beforeEach(() => captureCheckIn.mockClear());

  it("sends nothing when Sentry is not configured", async () => {
    const { initSentry, reportHeartbeat } = await load();
    initSentry({ environment: "test", service: "worker" });
    reportHeartbeat({ slug: "worker", intervalMinutes: 1 });
    expect(captureCheckIn).not.toHaveBeenCalled();
  });

  it("checks in and upserts the monitor's schedule from code", async () => {
    const { initSentry, reportHeartbeat } = await load();
    initSentry({
      dsn: "https://key@example.ingest.sentry.io/1",
      environment: "test",
      service: "worker",
    });
    reportHeartbeat({ slug: "worker", intervalMinutes: 1 });
    expect(captureCheckIn).toHaveBeenCalledWith(
      { monitorSlug: "worker", status: "ok" },
      expect.objectContaining({
        schedule: { type: "interval", value: 1, unit: "minute" },
        failureIssueThreshold: 2,
      }),
    );
  });
});
