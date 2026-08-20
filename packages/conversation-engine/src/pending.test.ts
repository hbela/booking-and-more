import { describe, expect, it } from "vitest";

import {
  checkPendingActionUsable,
  effectivePendingActionStatus,
  pendingActionExpiresAt,
  readConfirmation,
  type PendingActionView,
} from "./pending.js";
import { checkTurnAllowed, conversationExpiresAt } from "./turns.js";

const NOW = new Date("2026-08-10T12:00:00Z");

function action(overrides: Partial<PendingActionView> = {}): PendingActionView {
  return {
    id: "pac_1",
    sessionId: "cnv_1",
    toolName: "confirmBooking",
    status: "PENDING",
    expiresAt: new Date("2026-08-10T12:03:00Z"),
    ...overrides,
  };
}

describe("checkPendingActionUsable", () => {
  it("allows a live action from its own session", () => {
    expect(checkPendingActionUsable({ action: action(), sessionId: "cnv_1", now: NOW })).toEqual({
      allowed: true,
    });
  });

  it("refuses an action belonging to another conversation", () => {
    // "Cannot guess" is not an authorization model.
    expect(
      checkPendingActionUsable({ action: action(), sessionId: "cnv_2", now: NOW }),
    ).toMatchObject({ allowed: false, reason: "PENDING_ACTION_WRONG_SESSION" });
  });

  it("refuses an expired one on the request that finds it", () => {
    // Not on the request after the sweeper next woke up.
    const late = new Date("2026-08-10T12:04:00Z");

    expect(checkPendingActionUsable({ action: action(), sessionId: "cnv_1", now: late })).toMatchObject(
      { allowed: false, reason: "PENDING_ACTION_EXPIRED" },
    );
  });

  it("refuses a second confirmation of the same action", () => {
    // A double-tap must not be a double booking.
    expect(
      checkPendingActionUsable({
        action: action({ status: "CONFIRMED" }),
        sessionId: "cnv_1",
        now: NOW,
      }),
    ).toMatchObject({ allowed: false, reason: "PENDING_ACTION_ALREADY_USED" });
  });

  it("checks the session before anything else", () => {
    // An action that is both expired and somebody else's must not tell the
    // caller which conversation it belongs to by way of a different reason.
    const late = new Date("2026-08-10T12:04:00Z");

    expect(
      checkPendingActionUsable({ action: action(), sessionId: "cnv_2", now: late }),
    ).toMatchObject({ reason: "PENDING_ACTION_WRONG_SESSION" });
  });
});

describe("effectivePendingActionStatus", () => {
  it("reads the clock rather than the column", () => {
    expect(effectivePendingActionStatus(action(), new Date("2026-08-10T12:05:00Z"))).toBe("EXPIRED");
    expect(effectivePendingActionStatus(action(), NOW)).toBe("PENDING");
  });

  it("leaves a settled status alone", () => {
    expect(
      effectivePendingActionStatus(action({ status: "CANCELLED" }), new Date("2027-01-01T00:00:00Z")),
    ).toBe("CANCELLED");
  });
});

describe("pendingActionExpiresAt", () => {
  it("is shorter than the hold it accompanies", () => {
    // A hold is 300 seconds by default. An action that outlived it would present
    // a card the customer can still press, whose pressing then fails.
    expect(pendingActionExpiresAt(NOW, 240).toISOString()).toBe("2026-08-10T12:04:00.000Z");
  });
});

describe("readConfirmation", () => {
  it("recognises agreement in both languages", () => {
    for (const yes of ["yes", "Confirm", "go ahead", "Book it", "igen", "Rendben", "megerősítem"]) {
      expect(readConfirmation(yes), yes).toBe("AFFIRMED");
    }
  });

  it("recognises refusal", () => {
    for (const no of ["no", "cancel", "nem", "mégsem"]) {
      expect(readConfirmation(no), no).toBe("DECLINED");
    }
  });

  it("treats anything hedged as unclear", () => {
    // PRD §9.14. The cost of an extra question is a question; the cost of a
    // false positive is a booking somebody did not make.
    for (const maybe of [
      "maybe",
      "I think so",
      "yes but can you move it later",
      "talán",
      "igen, de inkább háromkor",
    ]) {
      expect(readConfirmation(maybe), maybe).toBe("UNCLEAR");
    }
  });

  it("tolerates punctuation and casing", () => {
    expect(readConfirmation("  Igen!  ")).toBe("AFFIRMED");
  });
});

describe("turn limits", () => {
  it("allows a turn inside both ceilings", () => {
    expect(
      checkTurnAllowed({
        turnCount: 3,
        maxTurns: 40,
        expiresAt: "2026-08-10T12:30:00Z",
        now: NOW,
      }),
    ).toEqual({ allowed: true });
  });

  it("refuses once the conversation is out of turns", () => {
    expect(
      checkTurnAllowed({ turnCount: 40, maxTurns: 40, expiresAt: "2026-08-10T12:30:00Z", now: NOW }),
    ).toMatchObject({ allowed: false, reason: "TURN_LIMIT_REACHED" });
  });

  it("checks expiry first — an expired conversation has no turns left either", () => {
    expect(
      checkTurnAllowed({ turnCount: 0, maxTurns: 40, expiresAt: "2026-08-10T11:00:00Z", now: NOW }),
    ).toMatchObject({ allowed: false, reason: "CONVERSATION_EXPIRED" });
  });

  it("slides the deadline forward on every turn", () => {
    expect(conversationExpiresAt(NOW, 30).toISOString()).toBe("2026-08-10T12:30:00.000Z");
  });
});
