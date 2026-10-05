import { expect, test } from "@playwright/test";

for (const locale of ["en", "hu"] as const) {
  test(`${locale}: shared language counters and rejected saves preserve the owner's draft`, async ({
    page,
  }) => {
    const tenant = {
      id: "tenant-knowledge",
      name: "Knowledge Test",
      slug: "knowledge-test",
      status: "ACTIVE",
      defaultLanguage: "en",
    };
    await page.route("**/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/v1/assistant/settings" && route.request().method() === "PATCH") {
        return route.fulfill({
          status: 422,
          json: {
            error: {
              code: "VALIDATION_FAILED",
              message: "Content limit exceeded",
              details: { field: "knowledge", locale: "en", limit: 10_000, used: 10_001 },
            },
          },
        });
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
                "conversation:read:all",
                "assistant:manage",
                "service:manage",
              ],
              delegations: [],
            }
          : path === "/v1/tenants"
            ? { items: [tenant] }
            : path === "/v1/assistant/settings"
              ? {
                  businessDescriptionEn: "",
                  businessDescriptionHu: "",
                  businessDescriptionDe: "",
                  businessDescriptionFr: "",
                }
              : path === "/v1/services/knowledge-usage"
                ? {
                    limit: 10_000,
                    defaultLocale: "en",
                    locales: ["hu", "en", "de", "fr"].map((language) => ({
                      locale: language,
                      company: 0,
                      services: language === "en" ? 500 : 0,
                      faqs: 0,
                      used: language === "en" ? 500 : 0,
                      remaining: language === "en" ? 9500 : 10_000,
                    })),
                  }
                : path === "/v1/assistant/knowledge/health"
                  ? { errors: 0, warnings: 0, findings: [] }
                  : { items: [] };
      return route.fulfill({ json });
    });
    await page.goto(`/${locale}/dashboard`);
    const profile = page.locator('textarea[name="description-en"]');
    const form = profile.locator("xpath=ancestor::form");
    const draft = String.fromCodePoint(0x1f600).repeat(9501);
    await profile.fill(draft);
    await expect(profile).toHaveValue(draft);
    await expect(form.getByText(/EN.*10.001.*10.000/)).toBeVisible();
    await expect(form.getByText(/DE.*0.*10.000/)).toBeVisible();
    await form.locator('button[type="submit"]').click();
    await expect(
      page.getByText(locale === "en" ? /Your draft has been kept/ : /A beírt szöveg megmaradt/),
    ).toBeVisible();
    await expect(profile).toHaveValue(draft);
    await profile.fill("Reduced");
    await expect(form.getByText(/EN.*507.*10.000/)).toBeVisible();

    await page.goto(`/${locale}/dashboard/services`);
    const serviceDescription = page.locator("#new-service-description");
    await serviceDescription.fill("x".repeat(9501));
    const serviceForm = serviceDescription.locator("xpath=ancestor::form");
    await expect(serviceForm.getByText(/EN.*10.001.*10.000/)).toBeVisible();
    await expect(serviceDescription).toHaveValue("x".repeat(9501));
  });
}
