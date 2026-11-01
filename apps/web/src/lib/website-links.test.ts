import { describe, expect, it } from "vitest";
import { buildWebsiteLinks } from "./website-links";

const base = {
  origin: "https://app.example.test/",
  slug: "wellness",
  domain: "wellness-demo.appointer.hu",
  defaultLanguage: "hu",
  assistant: false,
};

describe("buildWebsiteLinks", () => {
  it("builds the booking links in both languages", () => {
    const links = buildWebsiteLinks(base);
    expect(links.booking).toEqual({
      hu: "https://app.example.test/wellness/book",
      en: "https://app.example.test/en/wellness/book",
    });
    expect(links.chat).toBeNull();
  });

  it("offers chat only when the plan includes it", () => {
    expect(buildWebsiteLinks({ ...base, assistant: true }).chat).toEqual({
      hu: "https://app.example.test/wellness/chat",
      en: "https://app.example.test/en/wellness/chat",
    });
  });

  it("signs staff in by domain when one is set, by slug otherwise", () => {
    expect(buildWebsiteLinks(base).staffSignIn).toBe(
      "https://app.example.test/wellness-demo.appointer.hu/sign-in",
    );
    expect(buildWebsiteLinks({ ...base, domain: null }).staffSignIn).toBe(
      "https://app.example.test/wellness/sign-in",
    );
  });

  it("writes the snippets in the organization's language, not the reader's", () => {
    const hu = buildWebsiteLinks(base);
    expect(hu.bookingButtonHtml).toContain('href="https://app.example.test/wellness/book"');
    expect(hu.bookingButtonHtml).toContain(">Foglaljon időpontot</a>");
    expect(hu.staffLinkHtml).toBe(
      '<a href="https://app.example.test/wellness-demo.appointer.hu/sign-in">Munkatársaknak</a>',
    );

    const en = buildWebsiteLinks({ ...base, defaultLanguage: "en" });
    expect(en.bookingButtonHtml).toContain('href="https://app.example.test/en/wellness/book"');
    expect(en.bookingButtonHtml).toContain(">Book an appointment</a>");
    expect(en.staffSignIn).toBe("https://app.example.test/en/wellness-demo.appointer.hu/sign-in");
    expect(en.staffInstall).toBe("https://app.example.test/en/wellness/install/staff");
  });
});
