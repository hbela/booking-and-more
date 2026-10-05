import { describe, expect, it } from "vitest";
import { groundingIssues, type GroundingFacts } from "./grounding.js";

// The wellness tenant's records (phase-12 §1.1), with a price set.
const facts: GroundingFacts = {
  services: [
    {
      id: "svc_1",
      name: "Konzultáció",
      names: ["Konzultáció"],
      priceMinor: 500_000,
      currency: "HUF",
      translatedLocales: [],
    },
  ],
  providers: [{ id: "p_1", name: "Dr Kiss Katalin", hasHours: true }],
  locationCities: ["Szentendre"],
  hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "17:00" })),
  acknowledgedPeople: ["Kocsis Zoltán"],
};

const hufFive = (() => {
  const digits =
    new Intl.NumberFormat("en", { style: "currency", currency: "HUF" }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  return (500_000 / 10 ** digits).toLocaleString("hu-HU").replace(/\s/gu, ".") + " Ft";
})();

describe("groundingIssues", () => {
  it("passes an answer that only repeats the records", () => {
    expect(
      groundingIssues(
        `Szentendrén, hétfőtől péntekig 09:00–17:00 között várjuk. Dr. Kiss Katalin rendel. A konzultáció ${hufFive}.`,
        facts,
      ),
    ).toEqual([]);
  });

  it("flags the profile's claims the records contradict", () => {
    expect(
      groundingIssues(
        "Budapesti rendelőnkben 8 és 20 óra között várjuk. Kiss Éva doktornő és Dr. Nagy Péter rendel. A Start csomag 31.000 Ft.",
        facts,
      ),
    ).toEqual([
      { kind: "PERSON", value: "Nagy Péter" },
      { kind: "PERSON", value: "Kiss Éva" },
      { kind: "CITY", value: "Budapest" },
      { kind: "HOURS", value: "08:00–20:00" },
      { kind: "PRICE", value: "31000 HUF" },
    ]);
  });

  it("lets the owner's acknowledged names through", () => {
    expect(groundingIssues("A rendelőt Dr. Kocsis Zoltán vezeti.", facts)).toEqual([]);
  });

  it("reports each value once", () => {
    expect(groundingIssues("Budapest.\nBudapesten is.", facts)).toEqual([
      { kind: "CITY", value: "Budapest" },
    ]);
  });
});
