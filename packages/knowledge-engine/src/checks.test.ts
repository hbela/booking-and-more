import { describe, expect, it } from "vitest";
import { checkKnowledge, hoursSummary } from "./checks.js";
import { findingKey } from "./key.js";
import { citiesIn, hourRanges, personNames, prices } from "./text.js";
import type { KnowledgeSnapshot } from "./types.js";

// The shape of the `wellness` tenant found on 2026-10-05 (phase-12 §1.1). The
// testimonial names are invented: real customers' names do not belong in a test.
const PROFILE = `## Bemutatkozás

A Wellness Fogászat Budapest prémium fogászati rendelő, amely 2013 óta szolgálja a budapesti lakosokat.

## Csapatunk

Dr. Kocsis Zoltán vezetésével csapatunk minden szakemberével együtt dolgozik.

## Szolgáltatásaink

- Általános fogászati kezelések
- Szájsebészet
- Konzultáció

## Új pácienseknek – Start csomag

- Panoráma röntgen felvétel készítése (10.000 Ft)
**Ára: 40.000 Ft helyett 31.000 Ft**

## Nyitvatartás

Hosszú nyitvatartással, hétfőtől péntekig 8 és 20 óra között várjuk Önt.

## Pácienseink véleménye

- „Kiss Éva doktornő keze aranyból van." – Minta Péter
- „A legjobb fogászat, és nem csak Szentendrén." – Teszt Anna`;

const wellness: KnowledgeSnapshot = {
  defaultLocale: "hu",
  supportedLocales: ["hu", "en"],
  services: [
    {
      id: "svc_1",
      name: "Konzultáció",
      names: ["Konzultáció"],
      priceMinor: null,
      currency: null,
      translatedLocales: [],
    },
  ],
  providers: [
    { id: "p_1", name: "Dr Kiss Katalin", hasHours: true },
    { id: "p_2", name: "Hauser Max", hasHours: false },
  ],
  locationCities: ["Szentendre"],
  hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "17:00" })),
  contactEmail: null,
  contactPhone: null,
  texts: [
    { kind: "PROFILE", id: null, name: null, locale: "hu", text: PROFILE },
    {
      kind: "SERVICE",
      id: "svc_1",
      name: "Konzultáció",
      locale: "hu",
      text: "**Start csomag:**\n- **Ár: 40.000 Ft helyett 31.000 Ft**",
    },
  ],
};

const codes = (snapshot: KnowledgeSnapshot) =>
  checkKnowledge(snapshot).map((entry) => `${entry.code}:${entry.excerpt}`);

describe("checkKnowledge on the wellness tenant", () => {
  const findings = checkKnowledge(wellness);
  const of = (code: string) => findings.filter((entry) => entry.code === code);

  it("K1: lists every offered item that is not a bookable service, and nothing bookable", () => {
    expect(of("UNBOOKABLE_SERVICE_MENTIONED").map((entry) => entry.excerpt)).toEqual([
      "Általános fogászati kezelések",
      "Szájsebészet",
    ]);
    expect(of("UNBOOKABLE_SERVICE_MENTIONED")[0]).toMatchObject({
      severity: "ERROR",
      rule: "K1",
      expected: ["Konzultáció"],
    });
  });

  it("K2: names people who are not providers, and spots the likely typo", () => {
    const people = of("PERSON_NOT_A_PROVIDER");
    expect(people.map((entry) => entry.excerpt)).toEqual(["Kocsis Zoltán", "Kiss Éva"]);
    expect(people[0]!.suggestion).toBeNull();
    expect(people[1]!.suggestion).toBe("Dr Kiss Katalin");
    expect(people[1]!.expected).toEqual(["Dr Kiss Katalin", "Hauser Max"]);
  });

  it("K3: reports Budapest once, and not the location's own city", () => {
    const cities = of("CITY_MISMATCH");
    expect(cities.map((entry) => entry.suggestion)).toEqual(["Budapest"]);
    expect(cities[0]!.expected).toEqual(["Szentendre"]);
  });

  it("K4: hours that disagree with working hours are an error", () => {
    expect(of("HOURS_MISMATCH")).toHaveLength(1);
    expect(of("HOURS_MISMATCH")[0]).toMatchObject({
      severity: "ERROR",
      expected: ["Mon–Fri 09:00–17:00"],
    });
  });

  it("K5 and K6: prices with nowhere to live, and the package stated twice", () => {
    expect(of("PRICE_NOT_RECORDED").length).toBeGreaterThan(0);
    expect(of("DUPLICATED_FACT")).toHaveLength(1);
    expect(of("DUPLICATED_FACT")[0]!.expected).toEqual(["Konzultáció"]);
  });

  it("K7: English has no profile and no service translation", () => {
    expect(
      of("LOCALE_MISSING").map((entry) => `${entry.source.kind}:${entry.source.locale}`),
    ).toEqual(["PROFILE:en", "SERVICE:en"]);
  });

  it("K8: each testimonial attributed to a named customer", () => {
    expect(of("PERSONAL_DATA").map((entry) => entry.excerpt)).toEqual([
      "Minta Péter",
      "Teszt Anna",
    ]);
  });

  it("records: no contact details, and a provider with no hours", () => {
    expect(of("CONTACT_MISSING")).toHaveLength(1);
    expect(of("PROVIDER_WITHOUT_HOURS").map((entry) => entry.source.name)).toEqual(["Hauser Max"]);
  });

  it("puts every error before every warning", () => {
    const severities = findings.map((entry) => entry.severity);
    expect(severities.indexOf("WARNING")).toBeGreaterThan(severities.lastIndexOf("ERROR"));
  });
});

describe("a consistent tenant", () => {
  it("has nothing to report", () => {
    expect(
      codes({
        ...wellness,
        supportedLocales: ["hu"],
        services: [{ ...wellness.services[0]!, priceMinor: 3_100_000, currency: "HUF" }],
        providers: [{ id: "p_1", name: "Dr Kiss Katalin", hasHours: true }],
        contactPhone: "+36 1 234 5678",
        texts: [
          {
            kind: "PROFILE",
            id: null,
            name: null,
            locale: "hu",
            text: "Szentendrei rendelőnkben Dr. Kiss Katalin várja.\n\nSzolgáltatásaink:\n- Konzultáció",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("hours restated correctly are only a warning", () => {
    const findings = checkKnowledge({
      ...wellness,
      texts: [{ kind: "FAQ", id: "f", name: "?", locale: "hu", text: "Nyitva: 9:00–17:00" }],
    });
    expect(findings.find((entry) => entry.rule === "K4")).toMatchObject({
      code: "HOURS_STATED",
      severity: "WARNING",
    });
  });
});

describe("the extractors stay narrow", () => {
  it("does not read a count, a phone number or a year as hours", () => {
    expect(hourRanges("3-5 alkalom szükséges")).toEqual([]);
    expect(hourRanges("Hívjon: 06-30-123-4567")).toEqual([]);
    expect(hourRanges("2013-2020 között")).toEqual([]);
    expect(hourRanges("8 és 20 óra között")).toEqual([{ start: 480, end: 1200 }]);
    expect(hourRanges("Open 9h-17h")).toEqual([{ start: 540, end: 1020 }]);
  });

  it("does not take a common word for a short city name", () => {
    expect(citiesIn("A vacsora után")).toEqual([]);
    expect(citiesIn("pecsét")).toEqual([]);
    expect(citiesIn("Győrben és Vácon")).toEqual(["Győr", "Vác"]);
  });

  it("needs a title to call something a person", () => {
    expect(personNames("Wellness Fogászat Budapest")).toEqual([]);
    expect(personNames("dr. Nagy Anna és Kovács Béla főorvos")).toEqual([
      "Nagy Anna",
      "Kovács Béla",
    ]);
  });

  it("reads Hungarian and euro price formats", () => {
    expect(prices("31.000 Ft, 31 000 HUF, €45,50")).toEqual([
      { amount: 31000, currency: "HUF" },
      { amount: 31000, currency: "HUF" },
      { amount: 45.5, currency: "EUR" },
    ]);
  });
});

describe("hoursSummary", () => {
  it("merges overlapping providers and groups identical days", () => {
    expect(
      hoursSummary([
        { weekday: 1, startTime: "09:00", endTime: "13:00" },
        { weekday: 1, startTime: "12:00", endTime: "17:00" },
        { weekday: 2, startTime: "09:00", endTime: "17:00" },
        { weekday: 6, startTime: "10:00", endTime: "12:00" },
      ]),
    ).toEqual(["Mon–Tue 09:00–17:00", "Sat 10:00–12:00"]);
  });
});

describe("findingKey", () => {
  const [first] = checkKnowledge({
    ...wellness,
    texts: [{ kind: "PROFILE", id: null, name: null, locale: "hu", text: "Dr. Kocsis Zoltán" }],
  });

  it("survives a change of case or punctuation, not a rewording", () => {
    expect(findingKey(first!)).toBe(findingKey({ ...first!, excerpt: "kocsis, ZOLTÁN" }));
    expect(findingKey(first!)).not.toBe(findingKey({ ...first!, excerpt: "Kocsis Péter" }));
  });

  it("tells the same excerpt in another source or language apart", () => {
    expect(findingKey(first!)).not.toBe(
      findingKey({ ...first!, source: { ...first!.source, kind: "FAQ" } }),
    );
    expect(findingKey(first!)).not.toBe(
      findingKey({ ...first!, source: { ...first!.source, locale: "en" } }),
    );
  });
});
