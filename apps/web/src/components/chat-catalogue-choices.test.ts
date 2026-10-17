import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatCatalogueChoices } from "./chat-catalogue-choices";

describe("chat catalogue choices", () => {
  it.each([
    ["de", "Leistungen", "Fachkräfte", "Minuten"],
    ["fr", "Prestations", "Professionnels", "minutes"],
  ] as const)(
    "localizes catalogue labels in %s",
    (locale, servicesLabel, providersLabel, duration) => {
      const html = renderToStaticMarkup(
        createElement(ChatCatalogueChoices, {
          locale,
          disabled: false,
          onPick: () => {},
          onPickProvider: () => {},
          services: [
            {
              id: "one",
              name: "Consultation",
              durationMinutes: 30,
              priceMinor: null,
              currency: null,
            },
          ],
          providers: [{ id: "one", displayName: "Test Provider" }],
        }),
      );
      expect(html).toContain(`aria-label="${servicesLabel}"`);
      expect(html).toContain(`aria-label="${providersLabel}"`);
      expect(html).toContain(duration);
    },
  );

  it("shows Hungarian service names and durations as selectable buttons", () => {
    const html = renderToStaticMarkup(
      createElement(ChatCatalogueChoices, {
        locale: "hu",
        disabled: false,
        onPick: () => {},
        onPickProvider: () => {},
        services: [
          { id: "one", name: "Konzultáció", durationMinutes: 30, priceMinor: null, currency: null },
          {
            id: "two",
            name: "Dentálhigiénia",
            durationMinutes: 60,
            priceMinor: 15000,
            currency: "HUF",
          },
        ],
      }),
    );
    expect(html).toContain('aria-label="Szolgáltatások"');
    expect(html).toContain("Konzultáció");
    expect(html).toContain("Dentálhigiénia");
    expect(html).toContain("30");
    expect(html).toContain("perc");
    // HUF has no minor unit: 15000 is 15 000 Ft, which a hard-coded `/ 100`
    // printed as 150 Ft while the dashboard and booking page said 15 000.
    expect(html).toMatch(/15\s000\sFt/);
    expect(html.match(/<button/g)).toHaveLength(2);
  });

  it("shows provider choices and disables them while a request is running", () => {
    const html = renderToStaticMarkup(
      createElement(ChatCatalogueChoices, {
        locale: "en",
        disabled: true,
        onPick: () => {},
        onPickProvider: () => {},
        providers: [{ id: "one", displayName: "Test Provider" }],
      }),
    );
    expect(html).toContain("Test Provider");
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-label="Providers"');
  });

  it("offers 'anyone available' before any name, as the form does", () => {
    const html = renderToStaticMarkup(
      createElement(ChatCatalogueChoices, {
        locale: "hu",
        disabled: false,
        onPick: () => {},
        onPickProvider: () => {},
        providers: [{ id: "one", displayName: "Dr Kiss Katalin" }],
      }),
    );
    expect(html.indexOf("Bárki, aki ráér")).toBeGreaterThan(-1);
    expect(html.indexOf("Bárki, aki ráér")).toBeLessThan(html.indexOf("Dr Kiss Katalin"));
    expect(html.match(/<button/g)).toHaveLength(2);
  });
});
