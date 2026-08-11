import { describe, expect, it } from "vitest";

import {
  INTENT_PARAMETERS,
  conversationIntentSchema,
  parseCommand,
} from "./conversation.js";

/**
 * tech-impl §21's rule, tested: never execute parameters before validating them
 * against the intent-specific schema. A well-formed envelope carrying garbage
 * parameters is the case that matters — it passes the first validation, which is
 * exactly why there has to be a second.
 */

const wellFormed = {
  intent: "SEARCH_SLOTS",
  confidence: 0.9,
  parameters: { serviceQuery: "fogászati kontroll", dateExpression: "jövő kedden" },
  missingFields: [],
  requiresConfirmation: false,
};

describe("parseCommand", () => {
  it("accepts a well-formed command", () => {
    const result = parseCommand(wellFormed);

    expect(result.ok).toBe(true);
    expect(result.ok && result.command.intent).toBe("SEARCH_SLOTS");
    expect(result.ok && result.command.parameters["dateExpression"]).toBe("jövő kedden");
  });

  it("rejects an envelope that is not one", () => {
    expect(parseCommand({ intent: "BOOK_EVERYTHING", confidence: 1 })).toMatchObject({
      ok: false,
      reason: "MALFORMED_ENVELOPE",
    });

    expect(parseCommand("yes")).toMatchObject({ ok: false, reason: "MALFORMED_ENVELOPE" });
    expect(parseCommand(null)).toMatchObject({ ok: false, reason: "MALFORMED_ENVELOPE" });
  });

  it("rejects a confidence outside 0..1", () => {
    expect(parseCommand({ ...wellFormed, confidence: 1.4 })).toMatchObject({ ok: false });
  });

  it("rejects parameters the intent does not accept, having accepted the envelope", () => {
    const result = parseCommand({
      ...wellFormed,
      parameters: { serviceQuery: 42, dateExpression: { when: "soon" } },
    });

    expect(result).toMatchObject({ ok: false, reason: "INVALID_PARAMETERS" });
    expect(result.ok === false && result.issues.length).toBeGreaterThan(0);
  });

  it("strips a parameter the intent does not know about", () => {
    // A model being helpful must not fail the turn — but the extra key must not
    // reach a query either.
    const result = parseCommand({
      ...wellFormed,
      parameters: { serviceQuery: "cleaning", tenantId: "someone-elses-tenant" },
    });

    expect(result.ok).toBe(true);
    expect(result.ok && Object.hasOwn(result.command.parameters, "tenantId")).toBe(false);
  });

  it("refuses an email that is not one, in the intent that collects it", () => {
    const result = parseCommand({
      intent: "CREATE_BOOKING",
      confidence: 0.95,
      parameters: { fullName: "Nagy Péter", email: "nagy.peter at example.hu" },
      missingFields: [],
      requiresConfirmation: true,
    });

    expect(result).toMatchObject({ ok: false, reason: "INVALID_PARAMETERS" });
  });

  it("gives a provider-side intent no parameters to smuggle", () => {
    // Declared in the enum because tech-impl §21 declares one enum; unreachable
    // in a customer conversation because the tool allowlist has no entry.
    const result = parseCommand({
      intent: "BLOCK_TIME",
      confidence: 0.99,
      parameters: { providerId: "prv_1", startAt: "2026-08-11T09:00:00Z" },
      missingFields: [],
      requiresConfirmation: true,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.command.parameters).toEqual({});
  });

  it("defaults the optional envelope members", () => {
    const result = parseCommand({
      intent: "LIST_SERVICES",
      confidence: 0.8,
      requiresConfirmation: false,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.command.missingFields).toEqual([]);
    expect(result.ok && result.command.parameters).toEqual({});
  });
});

describe("the intent table", () => {
  it("has a parameter schema for every declared intent", () => {
    for (const intent of conversationIntentSchema.options) {
      expect(Object.hasOwn(INTENT_PARAMETERS, intent), `${intent} has no schema`).toBe(true);
    }
  });
});
