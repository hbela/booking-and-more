import { expect, test } from "@playwright/test";

// FormField marks a field mandatory from its control's own `required`
// attribute, through CSS `:has()`. The star must appear exactly where the
// browser will refuse an empty value, and must not leak into the accessible
// name — a screen reader already says "required" from the attribute.
test("the provisioning form stars its required fields and explains the star", async ({ page }) => {
  await page.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json:
        path === "/v1/me"
          ? {
              user: {
                id: "admin-1",
                name: "Operator",
                email: "operator@example.test",
                isPlatformAdmin: true,
              },
              tenant: null,
              membership: null,
              permissions: [],
              features: { assistant: false },
              delegations: [],
            }
          : { items: [] },
    });
  });

  await page.goto("/en/admin/platform");
  await expect(page.getByText("Fields marked * are required.")).toBeVisible();

  // The star is a CSS ::after, so ask the computed style rather than the DOM.
  const star = (label: string) =>
    page
      .locator("label", { hasText: label })
      .first()
      .evaluate((element) => getComputedStyle(element, "::after").content);

  for (const label of ["Organization name", "Owner email"]) {
    expect(await star(label)).toContain("*");
    // Neither the accessible name nor the label text carries the star; the
    // first span-based version broke every exact getByLabel in the suite.
    await expect(page.getByRole("textbox", { name: label, exact: true })).toBeVisible();
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }
  // A select with a default is never empty, so it is not marked.
  expect(await star("Type")).not.toContain("*");
});
