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
        services: [
          { id: "one", name: "Konzultáció", durationMinutes: 30, priceMinor: null, currency: null },
          {
            id: "two",
            name: "Dentálhigiénia",
            durationMinutes: 60,
            priceMinor: 1000000,
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
    expect(html.match(/<button/g)).toHaveLength(2);
  });

  it("shows provider choices and disables them while a request is running", () => {
    const html = renderToStaticMarkup(
      createElement(ChatCatalogueChoices, {
        locale: "en",
        disabled: true,
        onPick: () => {},
        providers: [{ id: "one", displayName: "Test Provider" }],
      }),
    );
    expect(html).toContain("Test Provider");
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-label="Providers"');
  });
});
