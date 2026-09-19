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
      await expect(page.getByText("Wellness Demo", { exact: true })).toBeVisible();
      await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
      await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
        "href",
        `/api/pwa/wellness-demo/${audience}/manifest?locale=${locale}`,
      );
      await expect(
        page.locator(
          `a[href="${prefix}/wellness-demo/${audience === "staff" ? "sign-in" : "book"}"]`,
        ),
      ).toBeVisible();
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
});

test("QR endpoints serve images and reject unsupported audiences", async ({ request }) => {
  const response = await request.get("/api/pwa/wellness-demo/staff/qr?locale=en");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toBe("image/svg+xml");
  expect(await response.text()).toContain("<svg");
  expect((await request.get("/api/pwa/wellness-demo/admin/qr")).status()).toBe(404);
});
