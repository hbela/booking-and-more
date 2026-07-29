import { describe, expect, it } from "vitest";
import {
  buildBookingSnapshot,
  customerMatches,
  normalizeEmail,
  normalizePhone,
} from "./snapshots.js";

describe("buildBookingSnapshot", () => {
  const customer = { fullName: "Nagy Péter", email: "peter@example.com", phone: "+36301234567" };

  it("records what the customer was told, not what the catalogue says today", () => {
    const snapshot = buildBookingSnapshot({
      customer,
      serviceName: "Fogkőeltávolítás",
      priceMinor: 12_000,
      currency: "HUF",
    });

    expect(snapshot).toEqual({
      customerName: "Nagy Péter",
      customerEmail: "peter@example.com",
      customerPhone: "+36301234567",
      serviceName: "Fogkőeltávolítás",
      priceMinor: 12_000,
      currency: "HUF",
    });
  });

  it("keeps an unpublished price as null rather than as zero", () => {
    // NULL means "on consultation", which is a different claim from "free".
    const snapshot = buildBookingSnapshot({
      customer,
      serviceName: "Konzultáció",
      priceMinor: null,
      currency: "HUF",
    });

    expect(snapshot.priceMinor).toBeNull();
    expect(snapshot.currency).toBeNull();
  });

  it("drops a price that arrives without a currency", () => {
    // A bare number is not a price anyone can act on. The columns are
    // independently nullable, so this is the only place the pairing can be
    // enforced.
    const snapshot = buildBookingSnapshot({
      customer,
      serviceName: "Konzultáció",
      priceMinor: 12_000,
      currency: null,
    });

    expect(snapshot.priceMinor).toBeNull();
    expect(snapshot.currency).toBeNull();
  });

  it("trims stray whitespace out of names", () => {
    const snapshot = buildBookingSnapshot({
      customer: { ...customer, fullName: "  Nagy Péter  " },
      serviceName: " Konzultáció ",
      priceMinor: null,
      currency: null,
    });

    expect(snapshot.customerName).toBe("Nagy Péter");
    expect(snapshot.serviceName).toBe("Konzultáció");
  });

  it("carries a customer who left no contact details", () => {
    // Staff booking somebody in over the counter. The name is all there is.
    const snapshot = buildBookingSnapshot({
      customer: { fullName: "Walk-in", email: null, phone: null },
      serviceName: "Konzultáció",
      priceMinor: null,
      currency: null,
    });

    expect(snapshot.customerEmail).toBeNull();
    expect(snapshot.customerPhone).toBeNull();
  });
});

describe("normalizeEmail", () => {
  it("folds case and trims", () => {
    expect(normalizeEmail("  Peter@Example.COM ")).toBe("peter@example.com");
  });

  it("leaves dots and plus-tags alone", () => {
    // Correct for one provider, wrong in general — and being wrong here
    // attaches one person's appointments to another person's record.
    expect(normalizeEmail("p.eter+dentist@example.com")).toBe("p.eter+dentist@example.com");
  });
});

describe("normalizePhone", () => {
  it("keeps a leading plus and strips punctuation", () => {
    expect(normalizePhone("+36 30 123 4567")).toBe("+36301234567");
    expect(normalizePhone("+36 (30) 123-4567")).toBe("+36301234567");
  });

  it("does not guess a country code", () => {
    // "06 30 123 4567" and "+36 30 123 4567" are one number to a Hungarian and
    // two keys here. Inferring the country from the server's locale is how a
    // predecessor merged a Hungarian customer with an Austrian one; the right
    // fix is asking, which belongs in the form.
    expect(normalizePhone("06 30 123 4567")).toBe("06301234567");
    expect(normalizePhone("06301234567")).not.toBe(normalizePhone("+36301234567"));
  });
});

describe("customerMatches", () => {
  const existing = { normalizedEmail: "peter@example.com", normalizedPhone: "+36301234567" };

  it("matches on either contact detail", () => {
    expect(customerMatches(existing, { email: "Peter@Example.com", phone: null })).toBe(true);
    expect(customerMatches(existing, { email: null, phone: "+36 30 123 4567" })).toBe(true);
  });

  it("does not match on name — there is no name here to match on", () => {
    expect(customerMatches(existing, { email: null, phone: null })).toBe(false);
  });

  it("does not match a different person", () => {
    expect(customerMatches(existing, { email: "anna@example.com", phone: "+36701111111" })).toBe(
      false,
    );
  });

  it("does not match two records that both normalise to nothing", () => {
    // "---" and "()" both reduce to the empty string. Treating that as a match
    // would collapse every junk phone number into one customer.
    expect(
      customerMatches(
        { normalizedEmail: null, normalizedPhone: "" },
        { email: null, phone: "---" },
      ),
    ).toBe(false);
  });

  it("does not match when the existing record has nothing stored", () => {
    expect(
      customerMatches(
        { normalizedEmail: null, normalizedPhone: null },
        { email: "peter@example.com", phone: "+36301234567" },
      ),
    ).toBe(false);
  });
});
