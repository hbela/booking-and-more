import { describe, expect, it } from "vitest";
import {
  checkBookingWindow,
  checkCancellable,
  checkReschedulable,
  mostRestrictiveAdvance,
  mostRestrictiveNotice,
} from "./policy.js";

const NOW = "2026-08-05T09:00:00.000Z";

describe("checkBookingWindow", () => {
  const base = { now: NOW, minimumNoticeMinutes: 60, maximumAdvanceDays: 30 };

  it("allows a start time comfortably inside the window", () => {
    expect(checkBookingWindow({ ...base, startAt: "2026-08-05T14:00:00Z" }).allowed).toBe(true);
  });

  it("catches the confirmation that was valid when the slot was searched for", () => {
    // The whole reason this check is repeated at write time. A search at 08:58
    // legitimately offered 10:00 for a service needing an hour's notice; the
    // customer then spent four minutes typing. Without this, the notice period
    // is enforced only against people who fill in forms quickly.
    const decision = checkBookingWindow({
      ...base,
      startAt: "2026-08-05T09:30:00Z",
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "MINIMUM_NOTICE_NOT_MET",
      detail: { minimumNoticeMinutes: 60, earliestStartAt: "2026-08-05T10:00:00.000Z" },
    });
  });

  it("treats the notice boundary as inclusive", () => {
    // Exactly an hour ahead satisfies an hour's notice.
    expect(checkBookingWindow({ ...base, startAt: "2026-08-05T10:00:00Z" }).allowed).toBe(true);
  });

  it("refuses a start time beyond the booking horizon", () => {
    const decision = checkBookingWindow({ ...base, startAt: "2026-10-05T10:00:00Z" });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "OUTSIDE_BOOKING_WINDOW",
      detail: { maximumAdvanceDays: 30 },
    });
  });

  it("reports a past start time as its own thing", () => {
    // Distinct from MINIMUM_NOTICE_NOT_MET: "that time has gone" is a different
    // sentence from "we need an hour's warning", and only one of them suggests
    // trying a slightly later slot.
    expect(checkBookingWindow({ ...base, startAt: "2026-08-05T08:00:00Z" })).toMatchObject({
      allowed: false,
      reason: "IN_THE_PAST",
    });
  });

  it("accepts anything future when no notice is required", () => {
    expect(
      checkBookingWindow({
        ...base,
        minimumNoticeMinutes: 0,
        startAt: "2026-08-05T09:00:00.001Z",
      }).allowed,
    ).toBe(true);
  });
});

describe("checkCancellable", () => {
  const base = { status: "CONFIRMED" as const, now: NOW, cancellationNoticeMinutes: null };

  it("allows cancelling a future appointment when no notice is configured", () => {
    expect(checkCancellable({ ...base, startAt: "2026-08-06T10:00:00Z" }).allowed).toBe(true);
  });

  it("refuses to cancel an appointment that has already started", () => {
    // The rule that needs no configuration. Cancelling this would release
    // capacity for time already spent and quietly rewrite what happened; staff
    // mark it NO_SHOW instead.
    expect(checkCancellable({ ...base, startAt: "2026-08-05T08:30:00Z" })).toMatchObject({
      allowed: false,
      reason: "ALREADY_STARTED",
    });
  });

  it("treats an appointment starting exactly now as started", () => {
    expect(checkCancellable({ ...base, startAt: NOW })).toMatchObject({
      allowed: false,
      reason: "ALREADY_STARTED",
    });
  });

  it("enforces a notice window when one is given", () => {
    const decision = checkCancellable({
      ...base,
      startAt: "2026-08-05T20:00:00Z",
      cancellationNoticeMinutes: 24 * 60,
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "TOO_LATE_TO_CANCEL",
      detail: { cancellationNoticeMinutes: 1440 },
    });
  });

  it("refuses a booking that is already cancelled or otherwise finished", () => {
    expect(
      checkCancellable({ ...base, status: "CANCELLED", startAt: "2026-08-06T10:00:00Z" }),
    ).toMatchObject({
      allowed: false,
      reason: "BOOKING_ALREADY_CANCELLED",
    });
    expect(
      checkCancellable({ ...base, status: "COMPLETED", startAt: "2026-08-06T10:00:00Z" }),
    ).toMatchObject({
      allowed: false,
      reason: "BOOKING_TERMINAL",
    });
  });

  it("allows cancelling a booking that is still awaiting approval", () => {
    expect(
      checkCancellable({ ...base, status: "PENDING", startAt: "2026-08-06T10:00:00Z" }).allowed,
    ).toBe(true);
  });
});

describe("checkReschedulable", () => {
  const base = {
    status: "CONFIRMED" as const,
    currentStartAt: "2026-08-10T10:00:00Z",
    now: NOW,
    cancellationNoticeMinutes: null,
    minimumNoticeMinutes: 60,
    maximumAdvanceDays: 30,
  };

  it("allows a move to a valid new time", () => {
    expect(checkReschedulable({ ...base, newStartAt: "2026-08-11T10:00:00Z" }).allowed).toBe(true);
  });

  it("refuses a move to the same instant", () => {
    // A request that means nothing: it would burn a reservation cycle and write
    // an audit entry describing a change that did not happen.
    expect(checkReschedulable({ ...base, newStartAt: "2026-08-10T10:00:00Z" })).toMatchObject({
      allowed: false,
      reason: "SAME_TIME",
    });
  });

  it("recognises the same instant written with a different offset", () => {
    expect(checkReschedulable({ ...base, newStartAt: "2026-08-10T12:00:00+02:00" })).toMatchObject({
      allowed: false,
      reason: "SAME_TIME",
    });
  });

  it("applies the cancellation rules to the appointment being left", () => {
    // The obvious bug this prevents: escaping a cancellation policy by moving
    // an appointment rather than cancelling it.
    const decision = checkReschedulable({
      ...base,
      currentStartAt: "2026-08-05T20:00:00Z",
      newStartAt: "2026-08-20T10:00:00Z",
      cancellationNoticeMinutes: 24 * 60,
    });

    expect(decision).toMatchObject({ allowed: false, reason: "TOO_LATE_TO_CANCEL" });
  });

  it("applies the booking window to the new time", () => {
    expect(checkReschedulable({ ...base, newStartAt: "2026-08-05T09:30:00Z" })).toMatchObject({
      allowed: false,
      reason: "MINIMUM_NOTICE_NOT_MET",
    });
    expect(checkReschedulable({ ...base, newStartAt: "2026-12-01T10:00:00Z" })).toMatchObject({
      allowed: false,
      reason: "OUTSIDE_BOOKING_WINDOW",
    });
  });

  it("refuses to reschedule a cancelled booking", () => {
    expect(
      checkReschedulable({ ...base, status: "CANCELLED", newStartAt: "2026-08-11T10:00:00Z" }),
    ).toMatchObject({ allowed: false, reason: "BOOKING_ALREADY_CANCELLED" });
  });
});

describe("inheritance", () => {
  it("takes the strictest notice and the shortest horizon", () => {
    // A provider needing a day and a service needing two hours means a day.
    expect(mostRestrictiveNotice([1440, 120], 0)).toBe(1440);
    expect(mostRestrictiveAdvance([365, 30], 180)).toBe(30);
  });

  it("treats NULL as 'inherit' rather than as a constraint", () => {
    expect(mostRestrictiveNotice([null, 120], 0)).toBe(120);
    expect(mostRestrictiveAdvance([null, 30], 180)).toBe(30);
  });

  it("falls back only when nothing sets a value", () => {
    expect(mostRestrictiveNotice([null, null], 0)).toBe(0);
    expect(mostRestrictiveAdvance([null, null], 180)).toBe(180);
  });
});
