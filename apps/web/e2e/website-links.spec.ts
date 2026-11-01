import { expect, test, type Page } from "@playwright/test";

// docs/customer-onboarding-and-website-links.md §2.2
async function mockDashboard(
  page: Page,
  { status, permissions }: { status: string; permissions: string[] },
): Promise<void> {
  const tenant = {
    id: "tenant-1",
    name: "Wellness Demo",
    slug: "wellness",
    status,
    defaultTimezone: "Europe/Budapest",
    defaultLanguage: "hu",
    domain: "wellness-demo.appointer.hu",
    subscribeBy: null,
    daysRemaining: null,
  };
  await page.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json:
        path === "/v1/me"
          ? {
              user: {
                id: "user-1",
                name: "Owner",
                email: "owner@example.test",
                isPlatformAdmin: false,
              },
              tenant,
              membership: { id: "member-1", role: "OWNER", providerId: null },
              features: { assistant: false },
              permissions,
              delegations: [],
            }
          : path === "/v1/tenants"
            ? { items: [tenant] }
            : { items: [] },
    });
  });
  await page.route("**/api/pwa/*/*/qr?*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: "<svg xmlns='http://www.w3.org/2000/svg'/>",
    }),
  );
}

test("a subscribed owner gets the links and snippets for their website", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockDashboard(page, { status: "ACTIVE", permissions: ["tenant:read", "tenant:manage"] });
  await page.goto("/en/dashboard");

  await expect(page.getByRole("heading", { name: "Put booking on your website" })).toBeVisible();
  const origin = new URL(page.url()).origin;
  await expect(
    page.getByRole("textbox", { name: "Booking page (Hungarian)", exact: true }),
  ).toHaveValue(`${origin}/wellness/book`);
  await expect(page.getByRole("textbox", { name: "Staff sign-in", exact: true })).toHaveValue(
    `${origin}/wellness-demo.appointer.hu/sign-in`,
  );
  await expect(page.getByRole("textbox", { name: "Chat (Hungarian)", exact: true })).toHaveCount(0);
  // The organization speaks Hungarian, so its snippet does, on an English dashboard.
  await expect(page.getByRole("textbox", { name: "Booking button", exact: true })).toHaveValue(
    />Foglaljon időpontot<\/a>$/u,
  );
  await expect(page.getByRole("textbox", { name: "Staff link", exact: true })).toHaveValue(
    `<a href="${origin}/wellness-demo.appointer.hu/sign-in">Munkatársaknak</a>`,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("website-links.png"), fullPage: true });
});

test("the section waits for the subscription, and is the owner's alone", async ({ page }) => {
  await mockDashboard(page, {
    status: "PENDING_SUBSCRIPTION",
    permissions: ["tenant:read", "tenant:manage"],
  });
  await page.goto("/en/dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Put booking on your website" })).toHaveCount(0);

  await page.unrouteAll();
  await mockDashboard(page, { status: "ACTIVE", permissions: ["tenant:read"] });
  await page.goto("/en/dashboard");
  await expect(page.getByRole("heading", { name: "Patient QR codes" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Put booking on your website" })).toHaveCount(0);
});
