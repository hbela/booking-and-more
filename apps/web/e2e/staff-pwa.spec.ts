import { expect, test, type Page } from "@playwright/test";

for (const [path, staffTitle, patientTitle, installLabel] of [
  ["/en", "For owners and staff", "For patients and customers", "Install app"],
  [
    "/hu",
    "Tulajdonosoknak és munkatársaknak",
    "Pácienseknek és ügyfeleknek",
    "Alkalmazás telepítése",
  ],
] as const) {
  test(`home page explains mobile access before sign-in: ${path}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.route("**/v1/me", (route) => route.fulfill({ status: 401, json: {} }));
    await page.goto(path);
    await expect(page.getByRole("heading", { name: staffTitle, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: patientTitle, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "iPhone / iPad · Safari" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Android · Chrome" })).toBeVisible();
    const install = page.getByRole("button", { name: installLabel, exact: true });
    await expect(install).toBeVisible();
    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt", { cancelable: true });
      Object.assign(event, {
        prompt: () => {
          document.documentElement.dataset.installPrompted = "true";
          return Promise.resolve();
        },
        userChoice: Promise.resolve({ outcome: "dismissed" }),
      });
      window.dispatchEvent(event);
    });
    await install.click();
    await expect(page.locator("html")).toHaveAttribute("data-install-prompted", "true");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("mobile-home.png"), fullPage: true });
  });
}

async function mockOrganizations(page: Page) {
  const tenants = [
    { id: "tenant-1", name: "Wellness Demo", slug: "wellness-demo", status: "ACTIVE" },
    { id: "tenant-2", name: "Second organization", slug: "second", status: "ACTIVE" },
  ];
  let active = tenants[0]!;
  await page.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/tenants/tenant-2/activate" && route.request().method() === "POST") {
      active = tenants[1]!;
      return route.fulfill({ json: {} });
    }
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
              tenant: active,
              membership: { id: "member-1", role: "OWNER", providerId: null },
              permissions: ["tenant:read", "billing:manage"],
              features: { assistant: false },
              delegations: [],
            }
          : path === "/v1/tenants"
            ? { items: tenants }
            : { items: [] },
    });
  });
}

async function readyWorker(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
}

test("manifest, raster icons and production worker headers are served directly", async ({
  request,
}) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({
    id: "/",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
  });
  for (const icon of manifest.icons as Array<{ src: string; type: string; sizes: string }>) {
    const response = await request.get(icon.src);
    expect(response.ok()).toBe(true);
    if (icon.type === "image/png") {
      const buffer = await response.body();
      expect(buffer.subarray(1, 4).toString()).toBe("PNG");
      expect(`${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)}`).toBe(icon.sizes);
    }
  }
  const apple = await request.get("/pwa/apple-touch-icon.png");
  expect((await apple.body()).readUInt32BE(16)).toBe(180);
  const worker = await request.get("/sw.js");
  expect(worker.headers()["content-type"]).toContain("javascript");
  expect(worker.headers()["cache-control"]).toContain("no-store");
});

for (const [path, title, retry] of [
  ["/en/sign-in", "You're offline", "Try again"],
  ["/sign-in", "Nincs internetkapcsolat", "Újrapróbálkozás"],
] as const) {
  test(`offline document navigation and retry: ${path}`, async ({ page, context }) => {
    await context.addCookies([
      {
        name: "NEXT_LOCALE",
        value: path.startsWith("/en") ? "en" : "hu",
        url: "http://127.0.0.1:3100",
      },
    ]);
    const response = await page.goto(path);
    expect(response?.headers()["content-security-policy"]).toContain("worker-src 'self'");
    await readyWorker(page);
    const currentUrl = page.url();
    await context.setOffline(true);
    await page.goto(currentUrl);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await context.setOffline(false);
    await page.getByRole("link", { name: retry }).click();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    const paths = await page.evaluate(async () => {
      const cachesForApp = (await caches.keys()).filter((key) =>
        key.startsWith("bam-staff-offline-"),
      );
      return (
        await Promise.all(
          cachesForApp.map(async (key) =>
            (await (await caches.open(key)).keys()).map((r) => new URL(r.url).pathname),
          ),
        )
      )
        .flat()
        .sort();
    });
    expect(paths).toEqual(
      [
        "/booking-and-more-mark.svg",
        "/pwa/offline-en.html",
        "/pwa/offline-hu.html",
        "/pwa/offline.css",
      ].sort(),
    );
  });
}

test("an open staff screen blocks interaction offline and restores the form online", async ({
  page,
  context,
}) => {
  await page.goto("/en/sign-in");
  await page.getByLabel("Email", { exact: true }).fill("person@example.test");
  await context.setOffline(true);
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  await expect(page.getByRole("alert", { name: "You're offline" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeHidden();
  await context.setOffline(false);
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("person@example.test");
});

test("customer chat does not register a worker or show staff installation controls", async ({
  page,
}) => {
  await page.route("**/v1/**", (route) =>
    route.fulfill({
      json: {
        available: false,
        personaName: "Assistant",
        branding: { businessName: "Demo" },
        supportedLocales: ["en", "hu"],
      },
    }),
  );
  await page.goto("/en/wellness-demo/chat");
  await expect(page.getByRole("button", { name: "Install app" })).toHaveCount(0);
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
  ).toBe(0);
});

test("staff dashboard offers installation without changing tenant or role", async ({ page }) => {
  await page.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const tenant = {
      id: "tenant-1",
      name: "Wellness Demo",
      slug: "wellness-demo",
      status: "ACTIVE",
    };
    return route.fulfill({
      json:
        path === "/v1/me"
          ? {
              user: {
                id: "user-1",
                name: "Staff",
                email: "staff@example.test",
                isPlatformAdmin: false,
              },
              tenant,
              membership: { id: "member-1", role: "PROVIDER", providerId: "provider-1" },
              permissions: ["tenant:read", "booking:read:own", "availability:manage:own"],
              features: { assistant: false },
              delegations: [],
            }
          : path === "/v1/tenants"
            ? { items: [tenant] }
            : { items: [] },
    });
  });
  await page.goto("/en/dashboard");
  const install = page.getByRole("button", { name: "Install app" });
  await expect(install).toBeVisible();
  await install.click();
  await expect(page.locator("#pwa-install-help")).toBeVisible();
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: () => {
        document.documentElement.dataset.installPrompted = "true";
        return Promise.resolve();
      },
      userChoice: Promise.resolve({ outcome: "accepted" }),
    });
    window.dispatchEvent(event);
  });
  await install.click();
  await expect(page.locator("html")).toHaveAttribute("data-install-prompted", "true");
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(install).toHaveCount(0);
  await expect(page.getByText("Wellness Demo", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Subscription", exact: true })).toHaveCount(0);
});

test("installed-mode launch hides install controls and preserves tenant switching", async ({
  page,
}) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true }));
  await mockOrganizations(page);
  await page.goto("/en/dashboard");
  await expect(page.getByText("Wellness Demo", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Install app" })).toHaveCount(0);
  await page.locator("#tenant").selectOption("tenant-2");
  await expect(
    page.locator("header").getByText("Second organization", { exact: true }).first(),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("#tenant")).toHaveValue("tenant-2");
});

test("installed start URL follows existing sign-in flow for an expired session", async ({
  page,
}) => {
  await page.route("**/v1/**", (route) =>
    route.fulfill({ status: 401, json: { error: { code: "UNAUTHORIZED", message: "Sign in" } } }),
  );
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in$/, { timeout: 15000 });
  await expect(page.locator('input[type="password"]')).toBeVisible();
});

test("mobile installation guidance and offline view fit a narrow viewport", async ({
  page,
  context,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "userAgent", { value: "iPhone Safari" }),
  );
  await mockOrganizations(page);
  await page.goto("/en/dashboard");
  await page.getByRole("button", { name: "Install app" }).click();
  await expect(page.locator("#pwa-install-help")).toContainText("Add to Home Screen");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("mobile-install.png"), fullPage: true });
  await context.setOffline(true);
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("mobile-offline.png"), fullPage: true });
});
