import { describe, expect, it } from "vitest";
import {
  renderBookableFacts,
  renderBusinessDescription,
  weeklyHours,
  type BookableFactsInput,
} from "./knowledge-context.js";

const hours = (weekday: number, startTime = "09:00", endTime = "17:00") => ({
  weekday,
  startTime,
  endTime,
  location: null,
});

// The `wellness` tenant as found on 2026-10-05 (phase-12 §1.1).
const wellness: BookableFactsInput = {
  services: [
    {
      name: "Konzultáció",
      durationMinutes: 30,
      priceMinor: null,
      currency: null,
      requiresApproval: false,
      translations: [],
      providers: [
        {
          customDurationMinutes: null,
          customPriceMinor: null,
          provider: { displayName: "Dr Kiss Katalin" },
        },
      ],
    },
  ],
  providers: [
    {
      displayName: "Dr Kiss Katalin",
      description: null,
      languages: ["hu"],
      workingHours: [1, 2, 3, 4, 5].map((day) => hours(day)),
    },
    { displayName: "Hauser Max", description: null, languages: [], workingHours: [] },
  ],
  locations: [
    {
      name: "Central",
      type: "PHYSICAL",
      addressLine1: "Szirt utca 11",
      addressLine2: null,
      postalCode: "2000",
      city: "Szentendre",
      countryCode: "HU",
    },
  ],
  contactEmail: null,
  contactPhone: null,
  bookingPolicy: null,
  cancellationPolicy: null,
};

describe("renderBookableFacts", () => {
  it("states every kind of fact from records, and says so when one is missing", () => {
    const facts = renderBookableFacts(wellness, "en");

    expect(facts).toContain("the complete list; nothing else can be booked");
    expect(facts).toContain(
      "- Konzultáció | 30 min | price: not recorded | performed by: Dr Kiss Katalin",
    );
    expect(facts).toContain("- Central: Szirt utca 11, 2000 Szentendre, HU");
    expect(facts).toContain("- Dr Kiss Katalin: Mon–Fri 09:00–17:00");
    expect(facts).toContain("- Hauser Max: none");
    expect(facts).toContain("Contact email: not recorded");
    expect(facts).toContain("Cancellation policy: not recorded");
  });

  it("lists people the owner confirmed are named but not bookable, apart from providers", () => {
    const facts = renderBookableFacts({ ...wellness, namedNotBookable: ["Kocsis Zoltán"] }, "hu");
    const people = facts.indexOf("cannot be booked (confirmed by the business");

    expect(people).toBeGreaterThan(facts.indexOf("Bookable providers"));
    expect(facts.slice(people)).toContain("- Kocsis Zoltán");
    expect(renderBookableFacts(wellness, "hu")).not.toContain("confirmed by the business");
  });

  it("uses the customer's locale for a translated service name", () => {
    const facts = renderBookableFacts(
      {
        ...wellness,
        services: [
          { ...wellness.services[0]!, translations: [{ locale: "en", name: "Consultation" }] },
        ],
      },
      "en",
    );

    expect(facts).toContain("- Consultation | 30 min");
    expect(facts).not.toContain("Konzultáció");
  });

  it("formats a price in the currency's own minor unit", () => {
    const service = wellness.services[0]!;
    const facts = renderBookableFacts(
      {
        ...wellness,
        services: [
          { ...service, priceMinor: 3_100_000, currency: "HUF" },
          {
            ...service,
            name: "Cleaning",
            priceMinor: 4_500,
            currency: "EUR",
            providers: [{ ...service.providers[0]!, customPriceMinor: 5_000 }],
          },
        ],
      },
      "hu",
    );

    // The minor-unit count is Intl's decision, not ours (see formatPrice), so the
    // expectation asks Intl too rather than hard-coding it.
    const hufDigits =
      new Intl.NumberFormat("en", { style: "currency", currency: "HUF" }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    expect(facts).toContain(`price: ${(3_100_000 / 10 ** hufDigits).toFixed(hufDigits)} HUF`);
    expect(facts).toContain("price: 45.00 EUR | performed by: Dr Kiss Katalin (50.00 EUR)");
  });
});

describe("weeklyHours", () => {
  it("collapses consecutive identical days and keeps differing ones apart", () => {
    expect(
      weeklyHours([
        hours(1),
        hours(2),
        hours(3, "09:00", "12:00"),
        hours(3, "13:00", "17:00"),
        hours(4),
        hours(6, "10:00", "14:00"),
      ]),
    ).toBe("Mon–Tue 09:00–17:00; Wed 09:00–12:00, 13:00–17:00; Thu 09:00–17:00; Sat 10:00–14:00");
  });

  it("drops hours at an inactive or archived location, as the engine does", () => {
    expect(
      weeklyHours([
        { ...hours(1), location: { name: "Old", active: true, archivedAt: new Date() } },
        { ...hours(2), location: { name: "Off", active: false, archivedAt: null } },
        { ...hours(3), location: { name: "Central", active: true, archivedAt: null } },
      ]),
    ).toBe("Wed 09:00–17:00 at Central");
  });

  it("is null for a provider with no hours", () => {
    expect(weeklyHours([])).toBeNull();
  });
});

describe("renderBusinessDescription", () => {
  it("labels every piece with the language it is written in", () => {
    const text = renderBusinessDescription({
      profile: { text: "## Bemutatkozás", locale: "hu" },
      services: [{ name: "Konzultáció", description: "Személyes konzultáció", locale: "hu" }],
      faqs: [{ question: "Van parkoló?", answer: "Igen.", locale: "hu" }],
    });

    expect(text).toContain("Company profile (written in Hungarian):\n## Bemutatkozás");
    expect(text).toContain("Service description — Konzultáció (written in Hungarian)");
    expect(text).toContain("FAQ (written in Hungarian):\nQ: Van parkoló?\nA: Igen.");
  });

  it("is empty when the business wrote nothing", () => {
    expect(renderBusinessDescription({ profile: null, services: [], faqs: [] })).toBe("");
  });
});
