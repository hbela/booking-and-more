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

  test(`${locale}: the AI review shows verified points and explains a used-up allowance`, async ({
    page,
  }) => {
    let audits = 0;
    await mockApi(page, async (route, path, method) => {
      if (path !== "/v1/assistant/knowledge/audit" || method !== "POST") return false;
      audits += 1;
      expect(route.request().postDataJSON()).toEqual({ locale });
      await route.fulfill(
        audits === 1
          ? {
              json: {
                findings: [
                  {
                    severity: "ERROR",
                    source: { kind: "PROFILE", id: null, name: null, locale: "hu" },
                    excerpt: "- Fogszabályozás",
                    explanation: "Csak a Konzultáció foglalható.",
                  },
                ],
                discarded: 1,
                cached: false,
              },
            }
          : {
              status: 429,
              json: {
                error: {
                  code: "USAGE_QUOTA_EXCEEDED",
                  message: "Used.",
                  requestId: "r",
                  details: null,
                },
              },
            },
      );
      return true;
    });

    await page.goto(`/${locale}/dashboard`);
    const card = page.locator("#knowledge-health");
    const run = card.getByRole("button", { name: en ? "Review with AI" : "Ellenőrzés MI-vel" });

    await run.click();
    await expect(card.getByText("Csak a Konzultáció foglalható.")).toBeVisible();
    await expect(
      card.getByText(en ? /1 suggestion was dropped/ : /1 javaslatot elvetettünk/),
    ).toBeVisible();

    await run.click();
    await expect(
      card.getByText(en ? /AI allowance has been used/ : /MI-keret elfogyott/),
    ).toBeVisible();
  });

  test(`${locale}: translation drafts fill the editor or the FAQ list and save nothing by themselves`, async ({
    page,
  }) => {
    const created: unknown[] = [];
    await mockApi(page, async (route, path, method) => {
      if (path === "/v1/assistant/knowledge/translation-draft" && method === "POST") {
        const body = route.request().postDataJSON() as { target: string; kind: string };
        await route.fulfill({
          json: {
            source: "hu",
            target: body.target,
            kind: body.kind,
            profile: body.kind === "PROFILE" ? `[${body.target}] Our services` : null,
            faqs:
              body.kind === "FAQ"
                ? [{ sourceId: "faq_1", question: "Is there parking?", answer: "Yes." }]
                : [],
          },
        });
        return true;
      }
      if (path === "/v1/assistant/faqs" && method === "POST") {
        created.push(route.request().postDataJSON());
        await route.fulfill({ status: 201, json: { id: "faq_2" } });
        return true;
      }
      if (path === "/v1/assistant/faqs") {
        await route.fulfill({
          json: {
            items: [{ id: "faq_1", locale: "hu", question: "Van parkoló?", answer: "Igen." }],
          },
        });
        return true;
      }
      return false;
    });

    await page.goto(`/${locale}/dashboard`);
    // An empty field is filled straight away, and marked as a draft.
    await page
      .locator("div")
      .filter({ has: page.locator('textarea[name="description-en"]') })
      .last()
      .getByRole("button", { name: en ? "Draft from Hungarian" : "Fordítás a(z) magyar szövegből" })
      .click();
    const english = page.locator('textarea[name="description-en"]');
    await expect(english).toHaveValue("[en] Our services");
    const marker = page.getByText(
      en ? /Machine-translated from Hungarian/ : /Gépi fordítás a\(z\) magyar/,
    );
    await expect(marker.first()).toBeVisible();
    // Typing makes it the owner's text.
    await english.press("End");
    await english.pressSequentially(".");
    await expect(marker).toHaveCount(0);

    // A field with text asks first.
    const german = page.locator('textarea[name="description-de"]');
    await german.fill("Eigener Text");
    await page
      .locator("div")
      .filter({ has: german })
      .last()
      .getByRole("button", { name: en ? "Draft from Hungarian" : "Fordítás a(z) magyar szövegből" })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: en ? "Replace" : "Csere" })
      .click();
    await expect(german).toHaveValue("[de] Our services");

    // FAQs come back as a list to add one by one.
    await page
      .getByRole("button", { name: en ? "Draft translations" : "Fordítások készítése" })
      .click();
    await expect(page.getByText("Is there parking?")).toBeVisible();
    await page.getByRole("button", { name: en ? "Add" : "Hozzáadás", exact: true }).click();
    await expect
      .poll(() => created)
      .toEqual([
        { locale: "en", question: "Is there parking?", answer: "Yes.", active: true, sortOrder: 0 },
      ]);
    await expect(page.getByText("Is there parking?")).toHaveCount(0);
    await page.screenshot({ path: `test-results/knowledge-drafts-${locale}.png`, fullPage: true });
  });

  test(`${locale}: a service translation is drafted per language and saved only with the form`, async ({
    page,
  }) => {
    const drafts: unknown[] = [];
    const saved: unknown[] = [];
    await mockApi(page, async (route, path, method) => {
      if (path === "/v1/me") {
        await route.fulfill({
          json: { ...me, permissions: [...me.permissions, "service:manage"] },
        });
        return true;
      }
      if (path === "/v1/services" && method === "GET") {
        await route.fulfill({
          json: {
            nextCursor: null,
            items: [
              {
                id: "svc_1",
                name: "Fogkőeltávolítás",
                slug: "fogko",
                description: "Ultrahangos tisztítás.",
                durationMinutes: 30,
                bufferBeforeMinutes: 0,
                bufferAfterMinutes: 0,
                priceMinor: null,
                currency: null,
                active: true,
                requiresApproval: false,
                minimumNoticeMinutes: null,
                maximumAdvanceDays: null,
                translations: [{ locale: "de", name: "Zahnsteinentfernung", description: null }],
                archivedAt: null,
                createdAt: "2026-10-01T00:00:00.000Z",
                updatedAt: "2026-10-01T00:00:00.000Z",
              },
            ],
          },
        });
        return true;
      }
      if (path === "/v1/assistant/knowledge/translation-draft" && method === "POST") {
        const body = route.request().postDataJSON() as { target: string };
        drafts.push(body);
        await route.fulfill({
          json: {
            source: "hu",
            target: body.target,
            kind: "SERVICE",
            profile: null,
            faqs: [],
            service: {
              name: `[${body.target}] Scaling`,
              description: `[${body.target}] Ultrasonic.`,
            },
          },
        });
        return true;
      }
      if (path === "/v1/services/svc_1/translations" && method === "PUT") {
        saved.push(route.request().postDataJSON());
        await route.fulfill({ json: { items: [] } });
        return true;
      }
      return false;
    });

    await page.goto(`/${locale}/dashboard/services`);
    await page.getByRole("button", { name: en ? "Translations" : "Fordítások" }).click();
    // The nearest block around the name field that holds a button: the row.
    const draftButton = (language: string) =>
      page
        .locator(`input[name="name-${language}"]`)
        .locator("xpath=ancestor::div[.//button][1]")
        .getByRole("button", {
          name: en ? "Draft from Hungarian" : "Fordítás a(z) magyar szövegből",
        });

    // The default language is the source and has no button of its own.
    await expect(
      page.getByRole("button", {
        name: en ? "Draft from Hungarian" : "Fordítás a(z) magyar szövegből",
      }),
    ).toHaveCount(3);

    // Empty fields are filled straight away, name and description both, and marked.
    await draftButton("en").click();
    await expect(page.locator('input[name="name-en"]')).toHaveValue("[en] Scaling");
    await expect(page.locator('textarea[name="description-en"]')).toHaveValue("[en] Ultrasonic.");
    expect(drafts).toEqual([{ target: "en", kind: "SERVICE", serviceId: "svc_1" }]);
    await expect(
      page.getByText(en ? /Machine-translated from Hungarian/ : /Gépi fordítás a\(z\) magyar/),
    ).toHaveCount(1);
    // Nothing was saved by drafting.
    expect(saved).toEqual([]);
    await page.screenshot({ path: `test-results/service-drafts-${locale}.png`, fullPage: true });

    // An existing translation is not replaced without asking.
    await draftButton("de").click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: en ? "Cancel" : "Mégse" }).click();
    await expect(page.locator('input[name="name-de"]')).toHaveValue("Zahnsteinentfernung");

    await page
      .locator('input[name="name-en"]')
      .locator("xpath=ancestor::form")
      .getByRole("button", { name: en ? "Save" : "Mentés", exact: true })
      .click();
    await expect
      .poll(() => saved)
      .toEqual([
        {
          translations: [
            { locale: "en", name: "[en] Scaling", description: "[en] Ultrasonic." },
            { locale: "de", name: "Zahnsteinentfernung", description: null },
          ],
        },
      ]);
  });

  // PARKED — site import (docs/phase-12-site-import.md §9): the card is not rendered.
  test.skip(`${locale}: the website import drafts the profile, services and FAQs and saves only what is added`, async ({
    page,
  }) => {
    const createdFaqs: unknown[] = [];
    const createdServices: unknown[] = [];
    const settingsSaves: unknown[] = [];
    await mockApi(page, async (route, path, method) => {
      if (path === "/v1/me") {
        await route.fulfill({
          json: {
            ...me,
            tenant: { ...tenant, domain: "wellness.hu" },
            permissions: [...me.permissions, "service:manage"],
          },
        });
        return true;
      }
      if (path === "/v1/assistant/knowledge/site-import" && method === "POST") {
        await route.fulfill({
          json: {
            domain: "wellness.hu",
            language: "hu",
            pages: [
              { url: "https://wellness.hu/", title: "Wellness" },
              { url: "https://wellness.hu/arak", title: "Árak" },
            ],
            profile: "## Rólunk\n\nCsaládi rendelő Szentendrén.",
            services: [
              {
                name: "Fogkőeltávolítás",
                description: "Ultrahangos tisztítás.",
                price: 12000,
                currency: "HUF",
                durationMinutes: null,
                sourceUrl: "https://wellness.hu/arak",
                existingServiceId: null,
              },
              {
                name: "Konzultáció",
                description: null,
                price: null,
                currency: null,
                durationMinutes: 20,
                sourceUrl: "https://wellness.hu/arak",
                existingServiceId: "svc_1",
              },
            ],
            faqs: [
              {
                question: "Van parkoló?",
                answer: "Igen, az udvarban.",
                sourceUrl: "https://wellness.hu/",
              },
            ],
            discarded: 1,
            cached: false,
          },
        });
        return true;
      }
      if (path === "/v1/assistant/faqs" && method === "POST") {
        createdFaqs.push(route.request().postDataJSON());
        await route.fulfill({ status: 201, json: { id: "faq_9" } });
        return true;
      }
      if (path === "/v1/services" && method === "POST") {
        createdServices.push(route.request().postDataJSON());
        await route.fulfill({ status: 201, json: { id: "svc_9" } });
        return true;
      }
      if (path === "/v1/assistant/settings" && method === "PATCH") {
        settingsSaves.push(route.request().postDataJSON());
        await route.fulfill({ json: {} });
        return true;
      }
      return false;
    });

    await page.goto(`/${locale}/dashboard`);
    await page
      .getByRole("button", { name: en ? "Read wellness.hu" : "wellness.hu beolvasása" })
      .click();
    await expect(page.getByText(en ? "2 pages read." : "2 oldal beolvasva.")).toBeVisible();

    // The profile goes into the editor, asking first because text is there.
    await page
      .getByRole("button", {
        name: en ? "Use as Hungarian profile" : "Legyen ez a(z) magyar profil",
      })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: en ? "Replace" : "Csere" })
      .click();
    await expect(page.locator('textarea[name="description-hu"]')).toHaveValue(
      "## Rólunk\n\nCsaládi rendelő Szentendrén.",
    );
    await expect(
      page.getByText(en ? /Drafted from wellness.hu/ : /Vázlat innen: wellness.hu/),
    ).toBeVisible();

    // A service already in the catalogue cannot be added twice.
    await expect(
      page.getByText(en ? "Already in your catalogue" : "Már szerepel a szolgáltatások között"),
    ).toBeVisible();

    // Add opens the ordinary create form; a duration the site did not give is required.
    await page
      .getByRole("button", { name: en ? "Add" : "Hozzáadás", exact: true })
      .first()
      .click();
    const duration = page.locator("#import-service-0-duration");
    await expect(page.locator("#import-service-0-name")).toHaveValue("Fogkőeltávolítás");
    await expect(duration).toHaveValue("");
    const create = page.getByRole("button", { name: en ? "Create" : "Létrehozás" });
    await create.click();
    expect(createdServices).toEqual([]);
    await page.screenshot({ path: `test-results/site-import-${locale}.png`, fullPage: true });
    await duration.fill("30");
    await create.click();
    await expect(page.getByText(en ? "Added" : "Hozzáadva", { exact: true })).toBeVisible();
    expect(createdServices).toEqual([
      expect.objectContaining({
        name: "Fogkőeltávolítás",
        description: "Ultrahangos tisztítás.",
        durationMinutes: 30,
        // HUF has no minor unit in the browser's currency data.
        priceMinor: 12_000,
        currency: "HUF",
      }),
    ]);

    // A FAQ is added in the default language.
    const faq = page.locator("li").filter({ hasText: "Van parkoló?" });
    await faq.getByRole("button", { name: en ? "Add" : "Hozzáadás", exact: true }).click();
    await expect
      .poll(() => createdFaqs)
      .toEqual([
        {
          locale: "hu",
          question: "Van parkoló?",
          answer: "Igen, az udvarban.",
          active: true,
          sortOrder: 0,
        },
      ]);

    // The profile was never saved by the import itself.
    expect(settingsSaves).toEqual([]);
  });

  test(`${locale}: a transcript shows what an answer said and what it named outside the records`, async ({
    page,
  }) => {
    await mockApi(page, async (route, path) => {
      if (path === "/v1/assistant/conversations") {
        await route.fulfill({
          json: {
            items: [
              {
                id: "c_1",
                locale: "hu",
                status: "COMPLETED",
                turnCount: 2,
                outcomeSuccessful: null,
                bookingId: null,
                customerId: null,
                startedAt: "2026-10-05T08:00:00.000Z",
                lastActivityAt: "2026-10-05T08:05:00.000Z",
                flaggedAnswers: 1,
              },
            ],
          },
        });
        return true;
      }
      if (path === "/v1/assistant/conversations/c_1") {
        await route.fulfill({
          json: {
            messages: [
              {
                id: "m_1",
                sender: "CUSTOMER",
                content: "Hol vannak?",
                structured: null,
                groundingWarnings: null,
                createdAt: "2026-10-05T08:00:00.000Z",
              },
              {
                id: "m_2",
                sender: "ASSISTANT",
                content: "conversation.answer",
                structured: { answer: "Budapesten várjuk." },
                groundingWarnings: [{ kind: "CITY", value: "Budapest" }],
                createdAt: "2026-10-05T08:00:01.000Z",
              },
            ],
          },
        });
        return true;
      }
      return false;
    });

    await page.goto(`/${locale}/dashboard/assistant`);
    const row = page.getByRole("button", {
      name: en ? /1 answer named something not in your records/ : /1 válasz olyat említett/,
    });
    await row.click();
    await expect(page.getByText("Budapesten várjuk.")).toBeVisible();
    await expect(page.getByText("conversation.answer")).toHaveCount(0);
    await expect(
      page.getByText(
        en
          ? /named something your records do not hold: Budapest/
          : /nincs a rögzített adatok között: Budapest/,
      ),
    ).toBeVisible();
  });
}
