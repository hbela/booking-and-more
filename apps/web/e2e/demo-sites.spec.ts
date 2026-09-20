import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import QRCode from "qrcode";

for (const tenant of ["wellness", "medicare"]) {
  for (const locale of ["hu", "en"]) {
    for (const width of [390, 1440]) {
      test(`${tenant} ${locale} at ${width}px: links, language and layout`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const qrImages = new Map<string, Buffer>();
        if (tenant === "wellness") {
          for (const language of ["hu", "en"]) {
            for (const audience of ["staff", "book"]) {
              const path = `/api/pwa/wellness-demo/${audience}/qr?locale=${language}`;
              const response = await page.request.get(path);
              expect(response.ok()).toBe(true);
              qrImages.set(path, await response.body());
            }
            // The chat QR requires an enabled tenant, supplied by this layout fixture.
            qrImages.set(
              `/api/pwa/wellness-demo/chat/qr?locale=${language}`,
              Buffer.from(
                await QRCode.toString(
                  `https://app.booking.appointer.hu${language === "en" ? "/en" : ""}/wellness-demo/chat`,
                  { type: "svg" },
                ),
              ),
            );
          }
        }
        await page.route("https://app.booking.appointer.hu/api/pwa/**", async (route) => {
          const url = new URL(route.request().url());
          await route.fulfill({
            body: qrImages.get(`${url.pathname}${url.search}`)!,
            contentType: "image/svg+xml",
          });
        });
        // Serve the real static files without requiring Docker or a second server.
        await page.route("https://demo.test/**", async (route) => {
          const path = new URL(route.request().url()).pathname;
          const file = path.endsWith("styles.css")
            ? "styles.css"
            : path.endsWith("patient-qr.js")
              ? "patient-qr.js"
              : path.startsWith("/en")
                ? "en/index.html"
                : "index.html";
          await route.fulfill({
            body: await readFile(resolve(process.cwd(), "../../demo", tenant, file)),
            contentType: file.endsWith("css")
              ? "text/css"
              : file.endsWith(".js")
                ? "text/javascript"
                : "text/html; charset=utf-8",
          });
        });
        await page.goto(`https://demo.test/${locale === "en" ? "en/" : ""}`);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        const prefix = locale === "en" ? "/en" : "";
        const links = page.locator('a[href^="https://app.booking.appointer.hu"]');
        const hrefs = await links.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("href")),
        );
        expect(new Set(hrefs)).toEqual(
          new Set([
            ...["book", "chat", "sign-in"].map(
              (action) =>
                `https://app.booking.appointer.hu${prefix}/${action === "sign-in" ? `${tenant}-demo.appointer.hu` : tenant === "wellness" ? "wellness-demo" : tenant}/${action}`,
            ),
            ...(tenant === "wellness"
              ? ["staff"].map(
                  (audience) =>
                    `https://app.booking.appointer.hu${prefix}/wellness-demo/install/${audience}`,
                )
              : []),
          ]),
        );
        if (tenant === "wellness") {
          const codes = page.locator('img[src*="/api/pwa/"]');
          await expect(codes).toHaveCount(3);
          await codes.last().scrollIntoViewIfNeeded();
          await expect
            .poll(() =>
              codes.evaluateAll((images) =>
                images.every((img) => (img as HTMLImageElement).naturalWidth > 0),
              ),
            )
            .toBe(true);
        }
        await page.screenshot({
          path: test.info().outputPath(`${tenant}-${locale}-${width}.png`),
          fullPage: true,
        });
        await page.getByRole("link", { name: locale === "en" ? "HU" : "EN", exact: true }).click();
        await expect(page.locator("html")).toHaveAttribute("lang", locale === "en" ? "hu" : "en");
        await page.unrouteAll({ behavior: "ignoreErrors" });
      });
    }
  }
}
