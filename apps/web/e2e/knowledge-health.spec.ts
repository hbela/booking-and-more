import { expect, test } from "@playwright/test";

/**
 * phase-12 §5.1: the knowledge check on Overview. The findings are a subset of
 * what the API returned for the `wellness` tenant on 2026-10-05.
 */
const health = {
  errors: 2,
  warnings: 2,
  findings: [
    {
      code: "UNBOOKABLE_SERVICE_MENTIONED",
      severity: "ERROR",
      rule: "K1",
      source: { kind: "PROFILE", id: null, name: null, locale: "hu" },
      excerpt: "Fogszabályozás",
      expected: ["Konzultáció"],
      suggestion: null,
    },
    {
      code: "PERSON_NOT_A_PROVIDER",
      severity: "ERROR",
      rule: "K2",
      source: { kind: "PROFILE", id: null, name: null, locale: "hu" },
      excerpt: "Kiss Éva",
      expected: ["Dr Kiss Katalin", "Hauser Max"],
      suggestion: "Dr Kiss Katalin",
    },
    {
      code: "LOCALE_MISSING",
      severity: "WARNING",
      rule: "K7",
      source: { kind: "SERVICE", id: null, name: null, locale: "en" },
      excerpt: "",
      expected: ["Konzultáció"],
      suggestion: null,
    },
    {
      code: "CONTACT_MISSING",
      severity: "WARNING",
      rule: null,
      source: { kind: "RECORDS", id: null, name: null, locale: null },
      excerpt: "",
      expected: [],
      suggestion: null,
    },
  ],
};

for (const locale of ["en", "hu"] as const) {
  test(`${locale}: the knowledge check lists findings, links to fixes and saves contact details`, async ({
    page,
  }) => {
    const tenant = {
      id: "tenant-health",
      name: "Wellness",
      slug: "wellness",
      status: "ACTIVE",
      defaultLanguage: "hu",
    };
    let patched: unknown = null;
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/v1/tenants/current" && request.method() === "PATCH") {
        patched = request.postDataJSON();
        return route.fulfill({ json: patched });
      }
      const json =
        path === "/v1/me"
          ? {
              user: {
                id: "owner",
                name: "Owner",
                email: "owner@example.test",
                emailVerified: true,
                isPlatformAdmin: false,
              },
              tenant,
              membership: { id: "member", role: "OWNER", providerId: null },
              features: { assistant: true },
              permissions: [
                "tenant:read",
                "tenant:manage",
                "conversation:read:all",
                "assistant:manage",
              ],
              delegations: [],
            }
          : path === "/v1/tenants"
            ? { items: [tenant] }
            : path === "/v1/assistant/knowledge/health"
              ? health
              : path === "/v1/tenants/current"
                ? {
                    contactEmail: null,
                    contactPhone: null,
                    bookingPolicy: null,
                    cancellationPolicy: null,
                  }
                : path === "/v1/assistant/settings"
                  ? {
                      businessDescriptionHu: "## Szolgáltatásaink\n\n- Fogszabályozás",
                      businessDescriptionEn: "",
                      businessDescriptionDe: "",
                      businessDescriptionFr: "",
                    }
                  : path === "/v1/services/knowledge-usage"
                    ? { limit: 10_000, defaultLocale: "hu", locales: [] }
                    : { items: [] };
      return route.fulfill({ json });
    });

    await page.goto(`/${locale}/dashboard`);
    const card = page.locator("#knowledge-health");

    await expect(
      card.getByText(locale === "en" ? "2 errors, 2 warnings." : "2 hiba, 2 figyelmeztetés."),
    ).toBeVisible();
    await expect(card.getByText(/Fogszabályozás/).first()).toBeVisible();
    await expect(card.getByText(/Dr Kiss Katalin\?/)).toBeVisible();
    await expect(
      card.getByRole("link", { name: locale === "en" ? "Fix it here" : "Javítás itt" }).first(),
    ).toHaveAttribute("href", new RegExp(`/dashboard/services$`));

    // The Hungarian profile field points at its findings.
    await expect(
      page.getByRole("link", {
        name: locale === "en" ? /2 problems in this text/ : /2 probléma ebben a szövegben/,
      }),
    ).toBeVisible();

    await page.locator("#contact-phone").fill("+36 26 123 456");
    await page
      .getByRole("button", {
        name: locale === "en" ? "Save contact details" : "Elérhetőségek mentése",
      })
      .click();
    await expect
      .poll(() => patched)
      .toEqual({
        contactEmail: null,
        contactPhone: "+36 26 123 456",
        bookingPolicy: null,
        cancellationPolicy: null,
      });
    await page.screenshot({ path: `test-results/knowledge-health-${locale}.png`, fullPage: true });
  });
}
