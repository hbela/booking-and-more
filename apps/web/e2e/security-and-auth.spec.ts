import { expect, test } from "@playwright/test";

test("serves a nonce-protected document with the production security policy", async ({ page }) => {
  const response = await page.goto("/en/sign-in");
  expect(response?.status()).toBe(200);

  const headers = response?.headers() ?? {};
  const csp = headers["content-security-policy"] ?? "";
  const nonce = csp.match(/'nonce-([^']+)'/u)?.[1];

  expect(nonce).toBeTruthy();
  expect(csp).toContain("frame-ancestors 'none'");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["permissions-policy"]).toContain("camera=()");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["strict-transport-security"]).toContain("max-age=31536000");

  // Browsers deliberately hide nonce values from getAttribute(), returning an
  // empty string after parsing. Inspect the original response body instead.
  const html = (await response?.body())?.toString("utf8") ?? "";
  expect(html).toContain(`nonce="${nonce}"`);
});

test("sign-in controls follow a usable keyboard focus order", async ({ page }) => {
  await page.goto("/en/sign-in");

  const email = page.getByLabel("Email", { exact: true });
  const password = page.getByLabel("Password", { exact: true });
  const submit = page.getByRole("button", { name: "Sign in", exact: true });

  await email.focus();
  await expect(email).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(password).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(submit).toBeFocused();
});

test("security proxy preserves product locale detection and tenant-locale routing", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await expect(page).toHaveURL(/\/en\/sign-in$/u);

  await page.goto("/example-clinic/book");
  await expect(page).toHaveURL(/\/example-clinic\/book$/u);
});
