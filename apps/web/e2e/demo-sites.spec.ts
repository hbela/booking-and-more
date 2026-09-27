import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import QRCode from "qrcode";

for (const site of ["wellness", "wellness-local", "medicare"]) {
  const wellness = site.startsWith("wellness");
  const origin =
    site === "wellness-local" ? "http://localhost:3000" : "https://app.booking.appointer.hu";
  for (const locale of ["hu", "en"]) {
    for (const width of [390, 1440]) {
      for (const audience of wellness ? ["patient", "staff"] : ["index"]) {
        test(`${site} ${locale} ${audience} at ${width}px: links, language and layout`, async ({
          page,
        }) => {
          await page.setViewportSize({ width, height: 900 });
          await page.route(`${origin}/api/pwa/**`, async (route) => {
            const url = new URL(route.request().url());
            const action = url.pathname.split("/")[4];
            const language = url.searchParams.get("locale") === "en" ? "/en" : "";
            const destination = action === "staff" ? "install/staff" : action;
            await route.fulfill({
              contentType: "image/svg+xml",
              body: await QRCode.toString(`${origin}${language}/wellness/${destination}`, {
                type: "svg",
              }),
            });
          });
          await page.route("https://demo.test/**", async (route) => {
            const pathname = new URL(route.request().url()).pathname;
            const file = pathname.endsWith("/") ? pathname + "index.html" : pathname;
            await route.fulfill({
              body: await readFile(resolve(process.cwd(), "../../demo", site, file.slice(1))),
              contentType: file.endsWith(".css")
                ? "text/css"
                : file.endsWith(".js")
                  ? "text/javascript"
                  : "text/html; charset=utf-8",
            });
          });
          const prefix = locale === "en" ? "/en" : "";
          if (wellness && audience === "patient") {
            await page.goto(`https://demo.test${prefix}/`);
            await expect(page.getByRole("heading", { level: 1 })).toHaveText("Wellness");
            await page.locator('a[href="patient.html"]').click();
          } else {
            await page.goto(`https://demo.test${prefix}/${audience}.html`);
          }
          await expect(page.locator("html")).toHaveAttribute("lang", locale);
          await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
          const expected = wellness
            ? audience === "patient"
              ? ["wellness/book", "wellness/chat"]
              : ["wellness/sign-in", "wellness/install/staff"]
            : ["medicare/book", "medicare/chat", "medicare-demo.appointer.hu/sign-in"];
          const hrefs = await page
            .locator(`a[href^="${origin}"]`)
            .evaluateAll((elements) => elements.map((element) => element.getAttribute("href")));
          expect(new Set(hrefs)).toEqual(
            new Set(expected.map((path) => `${origin}${prefix}/${path}`)),
          );
          if (wellness) {
            const codes = page.locator('img[src*="/api/pwa/"]');
            await expect(codes).toHaveCount(audience === "patient" ? 2 : 1);
            await codes.last().scrollIntoViewIfNeeded();
            await expect
              .poll(() =>
                codes.evaluateAll((images) =>
                  images.every((img) => (img as HTMLImageElement).naturalWidth > 0),
                ),
              )
              .toBe(true);
          }
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
          await page.screenshot({
            path: test.info().outputPath(`${site}-${locale}-${audience}-${width}.png`),
            fullPage: true,
          });
          await page
            .getByRole("link", { name: locale === "en" ? "HU" : "EN", exact: true })
            .click();
          await expect(page.locator("html")).toHaveAttribute("lang", locale === "en" ? "hu" : "en");
          await page.unrouteAll({ behavior: "ignoreErrors" });
        });
      }
    }
  }
}
