import { describe, expect, it } from "vitest";
import {
  allowedTransitionsFrom,
  checkTransition,
  initialBookingStatus,
  isBlocking,
  isTerminal,
  releasesCapacity,
} from "./transitions.js";
import { BLOCKING_BOOKING_STATUSES, BookingStatuses, type BookingStatus } from "./types.js";

const ALL_STATUSES: BookingStatus[] = Object.values(BookingStatuses);

describe("the state machine", () => {
  it("lets staff accept or refuse a booking awaiting approval", () => {
    expect(checkTransition("PENDING", "CONFIRMED").allowed).toBe(true);
    expect(checkTransition("PENDING", "CANCELLED").allowed).toBe(true);
    expect(checkTransition("PENDING", "EXPIRED").allowed).toBe(true);
  });

  it("lets a confirmed appointment be cancelled, completed or marked a no-show", () => {
    expect(checkTransition("CONFIRMED", "CANCELLED").allowed).toBe(true);
    expect(checkTransition("CONFIRMED", "COMPLETED").allowed).toBe(true);
    expect(checkTransition("CONFIRMED", "NO_SHOW").allowed).toBe(true);
  });

  it("refuses to un-cancel a booking", () => {
    // The slot went back on sale the moment the cancellation committed, so this
    // cannot be a status change — the capacity may already belong to somebody
    // else. Reinstatement is a new booking. A predecessor allowed exactly this
    // transition and produced two confirmed bookings in one slot.
    expect(checkTransition("CANCELLED", "CONFIRMED")).toMatchObject({
      allowed: false,
      reason: "BOOKING_ALREADY_CANCELLED",
    });
  });

  it("refuses to reopen any terminal status", () => {
    expect(checkTransition("COMPLETED", "CONFIRMED")).toMatchObject({
      allowed: false,
      reason: "BOOKING_TERMINAL",
    });
    expect(checkTransition("NO_SHOW", "COMPLETED")).toMatchObject({
      allowed: false,
      reason: "BOOKING_TERMINAL",
    });
    expect(checkTransition("EXPIRED", "PENDING")).toMatchObject({
      allowed: false,
      reason: "BOOKING_TERMINAL",
    });
  });

  it("refuses to skip approval by going straight from PENDING to COMPLETED", () => {
    expect(checkTransition("PENDING", "COMPLETED")).toMatchObject({
      allowed: false,
      reason: "ILLEGAL_TRANSITION",
    });
    expect(checkTransition("PENDING", "NO_SHOW")).toMatchObject({
      allowed: false,
      reason: "ILLEGAL_TRANSITION",
    });
  });

  it("separates a repeated cancellation from an impossible one", () => {
    // A retried cancellation is usually success to the caller; "you cannot
    // cancel a completed appointment" never is. They must be distinguishable.
    expect(checkTransition("CANCELLED", "CANCELLED")).toMatchObject({
      allowed: false,
      reason: "BOOKING_ALREADY_CANCELLED",
    });
    expect(checkTransition("CONFIRMED", "CONFIRMED")).toMatchObject({
      allowed: false,
      reason: "BOOKING_ALREADY_IN_STATUS",
      detail: { status: "CONFIRMED" },
    });
  });
});

describe("terminality", () => {
  it("agrees with the transition table", () => {
    for (const status of ALL_STATUSES) {
      expect(isTerminal(status)).toBe(allowedTransitionsFrom(status).length === 0);
    }
  });

  it("names exactly the four end states", () => {
    expect(ALL_STATUSES.filter(isTerminal).sort()).toEqual([
      "CANCELLED",
      "COMPLETED",
      "EXPIRED",
      "NO_SHOW",
    ]);
  });
});

describe("capacity", () => {
  it("blocks the diary for exactly PENDING and CONFIRMED", () => {
    // This set is written twice — here and in the exclusion constraint's WHERE
    // clause. A disagreement is either a double booking or a slot nobody can
    // ever book, so the migration is asserted against this list in the API's
    // integration tests.
    expect(ALL_STATUSES.filter(isBlocking).sort()).toEqual(["CONFIRMED", "PENDING"]);
    expect([...BLOCKING_BOOKING_STATUSES].sort()).toEqual(["CONFIRMED", "PENDING"]);
  });

  it("frees the slot on cancellation and expiry only", () => {
    expect(releasesCapacity("CANCELLED")).toBe(true);
    expect(releasesCapacity("EXPIRED")).toBe(true);

    // The appointment happened, or the time was set aside and wasted. Either
    // way it was genuinely consumed, and leaving the reservation in place stops
    // a careless backfill writing a second booking over a past one.
    expect(releasesCapacity("COMPLETED")).toBe(false);
    expect(releasesCapacity("NO_SHOW")).toBe(false);
  });

  it("keeps a booking awaiting approval blocking its slot", () => {
    // The customer asked first. Staff deciding slowly must not cost them the
    // appointment.
    expect(isBlocking("PENDING")).toBe(true);
  });
});

describe("initialBookingStatus", () => {
  it("honours Service.requiresApproval", () => {
    expect(initialBookingStatus({ requiresApproval: true })).toBe("PENDING");
    expect(initialBookingStatus({ requiresApproval: false })).toBe("CONFIRMED");
  });
});
