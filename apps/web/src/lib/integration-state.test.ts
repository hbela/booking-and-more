import { describe, expect, it } from "vitest";
import {
  canRetry,
  healthTone,
  isSuccessOutcome,
  parseCallbackOutcome,
  resolveIntegrationHealth,
  writeCalendarOf,
  type CalendarIntegrationView,
} from "./integration-state";

/**
 * The ordering these tests exist for is the one between `needsReconnect` and
 * `failed`: a dead grant parks rows, so both are true at once, and showing the
 * wrong one hands somebody a Retry button that cannot work.
 */

const base: Pick<CalendarIntegrationView, "status" | "lastError" | "calendars" | "sync"> = {
  status: "ACTIVE",
  lastError: null,
  calendars: [
    {
      id: "map_1",
      externalCalendarId: "anna@example.test",
      calendarName: "Anna",
      writeBookings: true,
      readBusy: false,
      active: true,
    },
  ],
  sync: { pending: 0, syncing: 0, synced: 0, failed: 0 },
};

describe("resolveIntegrationHealth", () => {
  it("reports a healthy connection once everything has landed", () => {
    const health = resolveIntegrationHealth({
      ...base,
      sync: { pending: 0, syncing: 0, synced: 12, failed: 0 },
    });

    expect(health).toEqual({ kind: "healthy", synced: 12 });
    expect(healthTone(health)).toBe("success");
    expect(canRetry(health)).toBe(false);
  });

  it("counts pending and syncing together as work in flight", () => {
    // The backfill draining looks exactly like a booking on its way, and the
    // distinction is not one a provider could act on.
    expect(
      resolveIntegrationHealth({
        ...base,
        sync: { pending: 3, syncing: 2, synced: 10, failed: 0 },
      }),
    ).toEqual({ kind: "syncing", queued: 5 });
  });

  it("reports parked events as a failure worth retrying", () => {
    // tech-impl §25.6's "Calendar sync failed / Retry scheduled".
    const health = resolveIntegrationHealth({
      ...base,
      sync: { pending: 0, syncing: 0, synced: 4, failed: 2 },
    });

    expect(health).toEqual({ kind: "failed", failed: 2 });
    expect(canRetry(health)).toBe(true);
  });

  /**
   * **The assertion this module exists for.**
   *
   * A grant that dies parks every row behind it, so `NEEDS_RECONNECT` and
   * `failed > 0` are the normal state *together*. Reporting the failure would
   * offer a Retry whose requeued rows the processor hands straight back — the
   * provider presses it, nothing changes, and nothing tells them why.
   */
  it("puts re-consent ahead of retrying when both are true", () => {
    const health = resolveIntegrationHealth({
      ...base,
      status: "NEEDS_RECONNECT",
      lastError: "invalid_grant",
      sync: { pending: 1, syncing: 0, synced: 4, failed: 9 },
    });

    expect(health).toEqual({ kind: "needsReconnect", lastError: "invalid_grant" });
    expect(canRetry(health)).toBe(false);
    expect(healthTone(health)).toBe("danger");
  });

  it("asks for a calendar before it reports anything about syncing", () => {
    // Nothing is selected, so there is nothing to have failed and nothing to
    // retry — only a choice nobody has made.
    expect(
      resolveIntegrationHealth({
        ...base,
        calendars: [],
        sync: { pending: 0, syncing: 0, synced: 0, failed: 3 },
      }),
    ).toEqual({ kind: "noCalendar" });
  });

  it("treats a deactivated calendar as no calendar at all", () => {
    // What a re-point leaves behind: the old mapping stays as the record of what
    // was written there, but it is not where bookings go any more.
    expect(
      resolveIntegrationHealth({
        ...base,
        calendars: [{ ...base.calendars[0]!, active: false }],
      }),
    ).toEqual({ kind: "noCalendar" });
  });

  it("ignores a calendar that is not written to", () => {
    // `readBusy`-only mappings arrive in part 2 and must not read as a write
    // target — this is the assertion that keeps that from being a surprise.
    expect(
      resolveIntegrationHealth({
        ...base,
        calendars: [{ ...base.calendars[0]!, writeBookings: false, readBusy: true }],
      }),
    ).toEqual({ kind: "noCalendar" });
  });

  it("says nothing alarming about a connection the user disconnected themselves", () => {
    const health = resolveIntegrationHealth({ ...base, status: "DISCONNECTED" });

    expect(health).toEqual({ kind: "disconnected" });
    // Neutral, not danger: this is a preference honoured, not a failure.
    expect(healthTone(health)).toBe("neutral");
  });
});

describe("writeCalendarOf", () => {
  it("finds the active writing calendar and nothing else", () => {
    expect(
      writeCalendarOf({
        calendars: [
          { ...base.calendars[0]!, id: "old", active: false },
          { ...base.calendars[0]!, id: "current" },
        ],
      })?.id,
    ).toBe("current");
  });

  it("is undefined when there is none", () => {
    expect(writeCalendarOf({ calendars: [] })).toBeUndefined();
  });
});

describe("parseCallbackOutcome", () => {
  it("recognises the outcomes the API sends", () => {
    expect(parseCallbackOutcome("connected")).toBe("connected");
    expect(parseCallbackOutcome("access_denied")).toBe("access_denied");
    expect(parseCallbackOutcome("missing_scope")).toBe("missing_scope");
  });

  it("narrows anything else rather than rendering it", () => {
    // The query string is attacker-supplied in the sense that anyone can type
    // it. A message keyed off the raw value would put arbitrary text on a
    // signed-in screen, which is a phishing surface.
    expect(parseCallbackOutcome("<script>alert(1)</script>")).toBe("unknown");
    expect(parseCallbackOutcome("Your account is suspended, call 0900...")).toBe("unknown");
  });

  it("says nothing at all when there is no parameter", () => {
    expect(parseCallbackOutcome(null)).toBeNull();
    expect(parseCallbackOutcome("")).toBeNull();
  });

  it("only calls the connected outcome a success", () => {
    expect(isSuccessOutcome("connected")).toBe(true);
    expect(isSuccessOutcome("access_denied")).toBe(false);
    expect(isSuccessOutcome("unknown")).toBe(false);
  });
});
