import { expect, test } from "@playwright/test";

test("domain login keeps Hungarian despite an English browser preference", async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: "NEXT_LOCALE", value: "en", url: "http://127.0.0.1:3100" }]);
  await page.route("**/v1/me", (route) => route.fulfill({ status: 401, json: {} }));
  const response = await page.goto("/wellness-demo.appointer.hu/sign-in");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).toContain("script-src");
  await expect(page.locator("html")).toHaveAttribute("lang", "hu");
  await expect(page).toHaveURL(/\/wellness-demo\.appointer\.hu\/sign-in$/);
  await expect(page.locator('input[type="email"]')).toBeVisible();
});

test("shared login sends platform administrators to admin without tenant activation", async ({
  page,
}) => {
  let activations = 0;
  await page.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/activate")) activations++;
    if (path === "/v1/auth/sign-in/email")
      return route.fulfill({ json: { user: { id: "admin" }, token: "fixture" } });
    if (path === "/v1/me")
      return route.fulfill({
        json: {
          user: {
            id: "admin",
            name: "Test Admin",
            email: "admin@example.test",
            isPlatformAdmin: true,
          },
          tenant: null,
          membership: null,
          permissions: [],
          features: { assistant: false },
          delegations: [],
        },
      });
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto("/en/sign-in");
  await page.getByLabel("Email", { exact: true }).fill("admin@example.test");
  await page.getByLabel("Password", { exact: true }).fill("test-password-only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/admin$/);
  expect(activations).toBe(0);
});

test("tenant sign-in has no public registration action", async ({ page }) => {
  await page.route("**/v1/me", (route) => route.fulfill({ status: 401, json: {} }));
  await page.goto("/en/medicare/sign-in");
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /create|register|sign up/i })).toHaveCount(0);
});

test("wrong-tenant session stays on login and can use another account", async ({ page }) => {
  let signedOut = false;
  let activations = 0;
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/me")
      return route.fulfill({
        status: signedOut ? 401 : 200,
        json: { user: { isPlatformAdmin: false } },
      });
    if (path === "/v1/tenants")
      return route.fulfill({ json: { items: [{ id: "wellness", slug: "wellness" }] } });
    if (path === "/v1/auth/sign-out") {
      signedOut = true;
      return route.fulfill({ json: { success: true } });
    }
    if (path.endsWith("/activate")) activations++;
    return route.fulfill({ json: {} });
  });
  await page.goto("/en/medicare-demo.appointer.hu/sign-in");
  await expect(page.getByRole("alert").filter({ hasText: "does not have access" })).toBeVisible();
  await expect(page).toHaveURL(/\/en\/medicare-demo\.appointer\.hu\/sign-in$/);
  expect(activations).toBe(0);
  await page.getByRole("button", { name: "Sign out and use another account" }).click();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  expect(signedOut).toBe(true);
});

test("activation failure never opens a different tenant", async ({ page }) => {
  await page.route("**/v1/me", (route) =>
    route.fulfill({ json: { user: { isPlatformAdmin: false } } }),
  );
  await page.route("**/v1/tenants", (route) =>
    route.fulfill({ json: { items: [{ id: "medicare", slug: "medicare" }] } }),
  );
  await page.route("**/v1/tenants/medicare/activate", (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await page.goto("/en/medicare/sign-in");
  await expect(page.getByRole("alert").filter({ hasText: "could not open" })).toBeVisible();
  await expect(page).toHaveURL(/\/en\/medicare\/sign-in$/);
});

for (const role of ["OWNER", "PROVIDER", "ASSISTANT"]) {
  for (const existingSession of [true, false]) {
    test(`${role}: ${existingSession ? "existing" : "fresh"} session activates before dashboard loads`, async ({
      page,
    }) => {
      let authenticated = existingSession;
      let activated = false;
      let activationStarted = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tenants = ["wellness", "medicare"].map((slug) => ({
        id: slug,
        slug,
        domain: `${slug}-demo.appointer.hu`,
        name: slug,
        status: "ACTIVE",
        role,
      }));
      await page.route("**/v1/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/v1/auth/sign-in/email") {
          authenticated = true;
          return route.fulfill({ json: { user: { id: "staff" }, token: "fixture" } });
        }
        if (path === "/v1/me") {
          if (!authenticated) return route.fulfill({ status: 401, json: {} });
          return route.fulfill({
            json: {
              user: {
                id: "staff",
                name: "Test Staff",
                email: "staff@example.test",
                isPlatformAdmin: false,
              },
              tenant: {
                ...tenants[activated ? 1 : 0],
                defaultTimezone: "Europe/Budapest",
                defaultLanguage: "hu",
                subscribeBy: null,
                daysRemaining: null,
              },
              membership: {
                id: "membership",
                role,
                providerId: role === "PROVIDER" ? "provider" : null,
              },
              permissions: [],
              features: { assistant: false },
              delegations: [],
            },
          });
        }
        if (path === "/v1/tenants") return route.fulfill({ json: { items: tenants } });
        if (path === "/v1/tenants/medicare/activate") {
          activationStarted = true;
          await gate;
          activated = true;
          return route.fulfill({ status: 204 });
        }
        return route.fulfill({ json: { items: [] } });
      });
      await page.goto("/en/medicare-demo.appointer.hu/sign-in");
      if (!existingSession) {
        await page.getByLabel("Email", { exact: true }).fill("staff@example.test");
        await page.getByLabel("Password", { exact: true }).fill("test-password-only");
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
      }
      await expect.poll(() => activationStarted).toBe(true);
      await expect(page).toHaveURL(/\/en\/medicare-demo\.appointer\.hu\/sign-in$/);
      await expect(page.getByRole("status")).toContainText("Checking your access");
      release();
      await expect(page).toHaveURL(/\/en\/dashboard$/);
      await expect(page.getByText(/Test Staff/).first()).toBeVisible();
      expect(activated).toBe(true);
    });
  }
}
