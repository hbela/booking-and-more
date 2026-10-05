import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * phase-12 §5.1, §3.3, §5.3: the knowledge check on Overview, marking a finding
 * as intended, and the gate on switching the assistant on. The findings are a
 * subset of what the API returned for the `wellness` tenant on 2026-10-05.
 */
const finding = <T extends { key: string }>(overrides: T) => ({
  rule: null as string | null,
  suggestion: null as string | null,
  expected: [] as string[],
  excerpt: "",
  acknowledgementId: null as string | null,
  ...overrides,
});

const person = finding({
  code: "PERSON_NOT_A_PROVIDER",
  severity: "ERROR",
  rule: "K2",
  source: { kind: "PROFILE", id: null, name: null, locale: "hu" },
  excerpt: "Kiss Éva",
  expected: ["Dr Kiss Katalin", "Hauser Max"],
  suggestion: "Dr Kiss Katalin",
  key: "PERSON_NOT_A_PROVIDER|PROFILE||hu|kiss eva",
});

const health = {
  errors: 2,
  warnings: 2,
  findings: [
    finding({
      code: "UNBOOKABLE_SERVICE_MENTIONED",
      severity: "ERROR",
      rule: "K1",
      source: { kind: "PROFILE", id: null, name: null, locale: "hu" },
      excerpt: "Fogszabályozás",
      expected: ["Konzultáció"],
      key: "UNBOOKABLE_SERVICE_MENTIONED|PROFILE||hu|fogszabalyozas",
    }),
    person,
    finding({
      code: "LOCALE_MISSING",
      severity: "WARNING",
      rule: "K7",
      source: { kind: "SERVICE", id: null, name: null, locale: "en" },
      expected: ["Konzultáció"],
      key: "LOCALE_MISSING|SERVICE||en|",
    }),
    finding({
      code: "CONTACT_MISSING",
      severity: "WARNING",
      source: { kind: "RECORDS", id: null, name: null, locale: null },
      key: "CONTACT_MISSING|RECORDS|||",
    }),
  ],
};

const acknowledged = {
  ...health,
  errors: 1,
  findings: health.findings.map((entry) =>
    entry.key === person.key ? { ...entry, acknowledgementId: "ack_1" } : entry,
  ),
};

const tenant = {
  id: "tenant-health",
  name: "Wellness",
  slug: "wellness",
  status: "ACTIVE",
  defaultLanguage: "hu",
};

const me = {
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
  permissions: ["tenant:read", "tenant:manage", "conversation:read:all", "assistant:manage"],
  delegations: [],
};

/** Every API read the two screens make; `handle` answers anything it wants first. */
async function mockApi(
  page: Page,
  handle: (route: Route, path: string, method: string) => Promise<boolean> | boolean,
) {
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (await handle(route, path, request.method())) return;
    const json =
      path === "/v1/me"
        ? me
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
                    enabled: false,
                    personaName: "Asszisztens",
                    businessDescriptionHu: "## Szolgáltatásaink\n\n- Fogszabályozás",
                    businessDescriptionEn: "",
                    businessDescriptionDe: "",
                    businessDescriptionFr: "",
                  }
                : path === "/v1/services/knowledge-usage"
                  ? { limit: 10_000, defaultLocale: "hu", locales: [] }
                  : path === "/v1/conversations/stats"
                    ? {
                        total: 0,
                        active: 0,
                        completed: 0,
                        successful: 0,
                        inputTokens: 0,
                        outputTokens: 0,
                      }
                    : { items: [] };
    await route.fulfill({ json });
  });
}

for (const locale of ["en", "hu"] as const) {
  const en = locale === "en";

  test(`${locale}: the knowledge check lists findings, links to fixes and saves contact details`, async ({
    page,
  }) => {
    let patched: unknown = null;
    await mockApi(page, async (route, path, method) => {
      if (path !== "/v1/tenants/current" || method !== "PATCH") return false;
      patched = route.request().postDataJSON();
      await route.fulfill({ json: patched });
      return true;
    });

    await page.goto(`/${locale}/dashboard`);
    const card = page.locator("#knowledge-health");

    await expect(
      card.getByText(en ? "2 errors, 2 warnings." : "2 hiba, 2 figyelmeztetés."),
    ).toBeVisible();
    await expect(card.getByText(/Fogszabályozás/).first()).toBeVisible();
    await expect(card.getByText(/Dr Kiss Katalin\?/)).toBeVisible();
    await expect(
      card.getByRole("link", { name: en ? "Fix it here" : "Javítás itt" }).first(),
    ).toHaveAttribute("href", new RegExp(`/dashboard/services$`));

    // The Hungarian profile field points at its findings.
    await expect(
      page.getByRole("link", {
        name: en ? /2 problems in this text/ : /2 probléma ebben a szövegben/,
      }),
    ).toBeVisible();

    await page.locator("#contact-phone").fill("+36 26 123 456");
    await page
      .getByRole("button", { name: en ? "Save contact details" : "Elérhetőségek mentése" })
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

  test(`${locale}: marking a finding as intended moves it aside and can be undone`, async ({
    page,
  }) => {
    let posted: unknown = null;
    let deleted: string | null = null;
    await mockApi(page, async (route, path, method) => {
      if (path === "/v1/assistant/knowledge/acknowledgements" && method === "POST") {
        posted = route.request().postDataJSON();
        await route.fulfill({ status: 201, json: acknowledged });
        return true;
      }
      if (path.startsWith("/v1/assistant/knowledge/acknowledgements/") && method === "DELETE") {
        deleted = path.split("/").at(-1)!;
        await route.fulfill({ json: health });
        return true;
      }
      return false;
    });

    await page.goto(`/${locale}/dashboard`);
    const card = page.locator("#knowledge-health");
    const kiss = card.locator("li", { hasText: "Kiss Éva" });

    await kiss.getByRole("button", { name: en ? "Mark as intended" : "Szándékos" }).click();
    await expect.poll(() => posted).toEqual({ key: person.key });
    await expect(
      card.getByText(en ? "1 error, 2 warnings." : "1 hiba, 2 figyelmeztetés."),
    ).toBeVisible();

    const aside = card.locator("details", {
      hasText: en ? "1 marked as intended" : "1 szándékosként megjelölve",
    });
    await aside.locator("summary").click();
    await aside.getByRole("button", { name: en ? "Undo" : "Visszavonás" }).click();
    await expect.poll(() => deleted).toBe("ack_1");
    await expect(
      card.getByText(en ? "2 errors, 2 warnings." : "2 hiba, 2 figyelmeztetés."),
    ).toBeVisible();
  });

  test(`${locale}: switching the assistant on is refused while knowledge has errors`, async ({
    page,
  }) => {
    await mockApi(page, async (route, path, method) => {
      if (path !== "/v1/assistant/settings" || method !== "PATCH") return false;
      await route.fulfill({
        status: 409,
        json: {
          error: {
            code: "KNOWLEDGE_HAS_ERRORS",
            message: "The assistant's knowledge has 2 unresolved errors.",
            requestId: "req",
            details: { errors: 2 },
          },
        },
      });
      return true;
    });

    await page.goto(`/${locale}/dashboard/assistant`);
    // Before trying: the screen already says why it would be refused.
    await expect(
      page.getByText(
        en
          ? "The assistant cannot be switched on yet: its knowledge has 2 unresolved errors."
          : "Az asszisztens még nem kapcsolható be: a tudásában 2 megoldatlan hiba van.",
      ),
    ).toBeVisible();

    await page.getByRole("checkbox").first().click();
    await page.getByRole("button", { name: en ? "Save settings" : "Beállítások mentése" }).click();
    const refusal = page.getByRole("alert").filter({
      hasText: en ? /was not switched on/ : /nem kapcsolt be/,
    });
    await expect(refusal).toBeVisible();
    await expect(
      refusal.getByRole("link", {
        name: en ? "Open the knowledge check" : "A tudás ellenőrzésének megnyitása",
      }),
    ).toHaveAttribute("href", /\/dashboard#knowledge-health$/);
  });
}
