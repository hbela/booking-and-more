import { expect, test } from "@playwright/test";

for (const locale of ["hu", "en"] as const) {
  for (const audience of ["staff", "patient"] as const) {
    test(`${locale} ${audience} installation belongs to the organization`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.route("**/v1/public/tenants/wellness-demo", (route) =>
        route.fulfill({ json: { id: "tenant-1", name: "Wellness Demo", slug: "wellness-demo" } }),
      );
      await page.route("**/v1/me", (route) => route.fulfill({ status: 401, json: {} }));
      const prefix = locale === "en" ? "/en" : "";
      await page.goto(`${prefix}/wellness-demo/install/${audience}`);
      if (audience === "patient") {
        await expect(page).toHaveURL(`${prefix}/wellness-demo/book`);
        await expect(page.getByRole("button", { name: "How to install", exact: true })).toHaveCount(
          0,
        );
        return;
      }
      await expect(page.getByText("Wellness Demo", { exact: true })).toBeVisible();
      await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
      await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
        "href",
        `/api/pwa/wellness-demo/${audience}/manifest?locale=${locale}`,
      );
      await expect(page.locator(`a[href="${prefix}/wellness-demo/sign-in"]`)).toBeVisible();
      await expect(page.getByRole("heading", { name: "iPhone / iPad · Safari" })).toBeVisible();
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      await page.evaluate(() => {
        const event = new Event("beforeinstallprompt", { cancelable: true });
        Object.assign(event, {
          prompt: () => {
            document.documentElement.dataset.prompted = "true";
            return Promise.resolve();
          },
          userChoice: Promise.resolve({ outcome: "dismissed" }),
        });
        window.dispatchEvent(event);
      });
      await page
        .getByRole("button", {
          name: locale === "en" ? "Install app" : "Alkalmazás telepítése",
          exact: true,
        })
        .click();
      await expect(page.locator("html")).toHaveAttribute("data-prompted", "true");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath("install.png"), fullPage: true });
    });
  }
}

test("unknown organization offers no install action", async ({ page }) => {
  await page.route("**/v1/public/tenants/missing", (route) =>
    route.fulfill({ status: 404, json: {} }),
  );
  await page.goto("/en/missing/install/staff");
  await expect(page.locator('main [role="alert"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Install app" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "How to install" })).toHaveCount(0);
});

test("without a native prompt the instructions are explicit, focused and in view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await page.route("**/v1/public/tenants/wellness-demo", (route) =>
    route.fulfill({ json: { id: "tenant-1", name: "Wellness Demo", slug: "wellness-demo" } }),
  );
  await page.goto("/en/wellness-demo/install/staff");
  const instructions = page.getByRole("button", { name: "How to install", exact: true });
  await instructions.click();
  const help = page.getByRole("region", { name: "How to install" });
  await expect(help).toBeFocused();
  await expect(help).toBeInViewport();
  await expect(help).toContainText("has not offered an installation prompt");
  await expect(help).toContainText("brave://apps");
  await instructions.click();
  await expect(help).toBeVisible();
});

test("QR endpoints serve images and reject unsupported audiences", async ({ request }) => {
  const response = await request.get("/api/pwa/wellness-demo/staff/qr?locale=en");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toBe("image/svg+xml");
  expect(await response.text()).toContain("<svg");
  expect((await request.get("/api/pwa/wellness-demo/admin/qr")).status()).toBe(404);
});

for (const mode of ["android-standalone", "ios-standalone", "ios-browser"] as const) {
  test(`legacy patient QR opens booking directly in ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((mode) => {
      Object.defineProperty(navigator, "userAgent", {
        value: mode.startsWith("ios") ? "iPhone Safari" : "Android Chrome",
      });
      if (mode === "ios-standalone") {
        Object.defineProperty(navigator, "standalone", { value: true });
      }
      if (mode === "android-standalone") {
        const matchMedia = window.matchMedia.bind(window);
        window.matchMedia = (query) => {
          const result = matchMedia(query);
          if (query === "(display-mode: standalone)") {
            Object.defineProperty(result, "matches", { value: true });
          }
          return result;
        };
      }
    }, mode);
    await page.route("**/v1/public/tenants/wellness-demo", (route) =>
      route.fulfill({ json: { id: "tenant-1", name: "Wellness Demo", slug: "wellness-demo" } }),
    );
    await page.goto("/en/wellness-demo/install/patient");
    await expect(page).toHaveURL("/en/wellness-demo/book");
    await expect(page.getByRole("button", { name: "How to install", exact: true })).toHaveCount(0);
  });
}
