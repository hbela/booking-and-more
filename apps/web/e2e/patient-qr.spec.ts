import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="white"/></svg>';

for (const assistant of [false, true]) {
  test(`dashboard offers ${assistant ? "booking and chat" : "booking only"} QR downloads`, async ({
    page,
  }) => {
    const tenant = {
      id: "tenant-1",
      name: "Wellness Demo",
      slug: "wellness-demo",
      status: "ACTIVE",
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
                features: { assistant },
                permissions: ["tenant:read"],
                delegations: [],
              }
            : path === "/v1/tenants"
              ? { items: [tenant] }
              : { items: [] },
      });
    });
    await page.route("**/api/pwa/*/*/qr?*", (route) =>
      route.fulfill({ contentType: "image/svg+xml", body: svg }),
    );
    await page.goto("/en/dashboard");
    await expect(
      page.getByRole("link", { name: "Download Booking QR", exact: true }),
    ).toHaveAttribute("download", "wellness-demo-book-en.svg");
    await expect(page.getByRole("link", { name: "Booking", exact: true })).toHaveAttribute(
      "href",
      "/en/wellness-demo/book",
    );
    const chat = page.getByRole("link", { name: "Download Chat QR", exact: true });
    if (assistant) {
      await expect(chat).toBeVisible();
      await expect(page.getByRole("link", { name: "Chat", exact: true })).toHaveAttribute(
        "href",
        "/en/wellness-demo/chat",
      );
    } else {
      await expect(chat).toHaveCount(0);
    }
  });

  for (const locale of ["hu", "en"]) {
    test(`demo ${locale} shows chat QR only when generation is permitted: ${assistant}`, async ({
      page,
    }) => {
      const root = new URL("../../../demo/wellness/", import.meta.url);
      await page.route("https://demo.test/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        const file = path.endsWith(".js")
          ? "patient-qr.js"
          : path.endsWith(".css")
            ? "styles.css"
            : locale === "en"
              ? "en/index.html"
              : "index.html";
        await route.fulfill({
          contentType: file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "text/html",
          body: await readFile(new URL(file, root), "utf8"),
        });
      });
      await page.route("https://app.booking.appointer.hu/api/pwa/**", (route) =>
        route.fulfill({
          status: route.request().url().includes("/chat/") && !assistant ? 404 : 200,
          contentType: "image/svg+xml",
          body: assistant || !route.request().url().includes("/chat/") ? svg : "",
        }),
      );
      await page.goto("https://demo.test/");
      const booking = page.locator('.mobile-app-card[href$="/book"]');
      await expect(booking).toBeVisible();
      const chat = page.locator('.mobile-app-card[href$="/chat"]');
      if (assistant) await expect(chat).toBeVisible();
      else await expect(chat).toBeHidden();
      await expect(page.locator('.mobile-app-card[href$="/install/staff"]')).toBeVisible();
    });
  }
}
