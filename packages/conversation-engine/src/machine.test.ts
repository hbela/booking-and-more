import { describe, expect, it } from "vitest";

import {
  allowedTransitionsFrom,
  checkTransition,
  isTerminal,
  missingFieldsFor,
  stateFor,
  type CollectedFields,
} from "./machine.js";

/**
 * Forget a field.
 *
 * `exactOptionalPropertyTypes` is on, so an optional field is cleared by
 * removing the key rather than by assigning `undefined` — which is also what the
 * conversation means: it does not know a name that is `undefined`, it does not
 * know one at all.
 */
function without(
  collected: CollectedFields,
  ...fields: (keyof CollectedFields)[]
): CollectedFields {
  const copy = { ...collected };
  for (const field of fields) delete copy[field];
  return copy;
}

const complete: CollectedFields = {
  serviceId: "svc_1",
  providerId: "prv_1",
  dateFrom: "2026-08-18",
  dateTo: "2026-08-18",
  startAt: "2026-08-18T12:00:00.000Z",
  holdId: "hld_1",
  fullName: "Nagy Péter",
  email: "nagy.peter@example.hu",
};

describe("stateFor", () => {
  it("starts by asking for a service", () => {
    expect(stateFor({})).toBe("SELECTING_SERVICE");
  });

  it("skips every question the customer already answered", () => {
    // "Can I book a cleaning with Anna next Tuesday afternoon" fills four fields
    // in one sentence. A machine that only steps one edge at a time would have
    // to enumerate that shortcut; deriving means it needs no special case.
    expect(
      stateFor({
        serviceId: "svc_1",
        providerId: "prv_1",
        dateFrom: "2026-08-18",
        dateTo: "2026-08-18",
      }),
    ).toBe("SELECTING_SLOT");
  });

  it("walks the ordinary path in order", () => {
    expect(stateFor({ serviceId: "svc_1" })).toBe("SELECTING_DATE");
    expect(stateFor({ serviceId: "svc_1", dateFrom: "2026-08-18" })).toBe("SELECTING_SLOT");
    expect(
      stateFor({ serviceId: "svc_1", dateFrom: "2026-08-18", startAt: "2026-08-18T12:00:00Z" }),
    ).toBe("HOLDING_SLOT");
    expect(stateFor(without(complete, "fullName"))).toBe("COLLECTING_CUSTOMER_DETAILS");
    expect(stateFor(complete)).toBe("AWAITING_CONFIRMATION");
  });

  it("falls back when a field is taken away", () => {
    // A customer who changes their mind about the time loses their slot, not
    // their whole conversation.
    expect(stateFor(without(complete, "startAt", "holdId"))).toBe("SELECTING_SLOT");
  });

  it("never derives out of a terminal state", () => {
    expect(stateFor({}, "COMPLETED")).toBe("COMPLETED");
    expect(stateFor(complete, "CANCELLED")).toBe("CANCELLED");
    expect(stateFor({}, "EXPIRED")).toBe("EXPIRED");
  });

  it("holds still while a confirmation is outstanding", () => {
    // Otherwise a preview would be re-derived out from under the card the
    // customer is looking at.
    expect(stateFor(complete, "AWAITING_CONFIRMATION")).toBe("AWAITING_CONFIRMATION");
    expect(stateFor(complete, "CONFIRMING_BOOKING")).toBe("CONFIRMING_BOOKING");
  });
});

describe("missingFieldsFor", () => {
  it("wants a name and a way to reach them", () => {
    expect(missingFieldsFor("COLLECTING_CUSTOMER_DETAILS", {})).toEqual(["fullName", "email"]);
  });

  it("accepts a phone instead of an email", () => {
    // The "email or phone" rule belongs to publicCustomerInputSchema; restating
    // it here would give the product two definitions of a reachable customer.
    expect(
      missingFieldsFor("COLLECTING_CUSTOMER_DETAILS", { fullName: "Nagy Péter", phone: "+36301234567" }),
    ).toEqual([]);
  });

  it("wants a provider alongside a slot", () => {
    expect(missingFieldsFor("SELECTING_SLOT", { startAt: "2026-08-18T12:00:00Z" })).toEqual([
      "providerId",
    ]);
  });
});

describe("checkTransition", () => {
  it("allows the ordinary forward step", () => {
    expect(checkTransition("SELECTING_SLOT", "HOLDING_SLOT")).toEqual({ allowed: true });
  });

  it("allows falling back to another slot from the confirm step", () => {
    // The slot can be taken between the preview and the confirm. That is
    // SLOT_NO_LONGER_AVAILABLE arriving from the database, and the conversation
    // should offer another time rather than end.
    expect(checkTransition("CONFIRMING_BOOKING", "SELECTING_SLOT")).toEqual({ allowed: true });
  });

  it("refuses a jump nothing draws", () => {
    expect(checkTransition("START", "COMPLETED")).toMatchObject({
      allowed: false,
      reason: "NOT_A_TRANSITION",
    });
  });

  it("refuses anything at all once the conversation is over", () => {
    expect(checkTransition("COMPLETED", "SELECTING_SLOT")).toMatchObject({
      allowed: false,
      reason: "CONVERSATION_FINISHED",
    });

    for (const terminal of ["COMPLETED", "CANCELLED", "EXPIRED"] as const) {
      expect(isTerminal(terminal)).toBe(true);
      expect(allowedTransitionsFrom(terminal)).toEqual([]);
    }
  });

  it("lets any live state be cancelled or expire", () => {
    for (const state of [
      "START",
      "SELECTING_SERVICE",
      "SELECTING_DATE",
      "SELECTING_SLOT",
      "HOLDING_SLOT",
      "AWAITING_CONFIRMATION",
    ] as const) {
      expect(allowedTransitionsFrom(state)).toContain("CANCELLED");
      expect(allowedTransitionsFrom(state)).toContain("EXPIRED");
    }
  });
});
