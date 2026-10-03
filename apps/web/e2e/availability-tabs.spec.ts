import { expect, test } from "@playwright/test";

// The availability screen's three sections are tabs (phase-11-shadcn-adoption
// §3.8). Radix unmounts an inactive tab by default, and the working-hours
// editor keeps a whole unsaved week in component state — so a tab switch would
// silently throw the week away and reload the stored one. Every panel is
// `forceMount`ed to prevent that; this is what proves it.
test("switching availability tabs keeps an unsaved week", async ({ page }) => {
  const tenant = {
    id: "tenant-1",
    name: "Wellness Demo",
    slug: "wellness-demo",
    status: "ACTIVE",
    defaultTimezone: "Europe/Budapest",
    defaultLanguage: "en",
    subscribeBy: null,
    daysRemaining: null,
  };
  const provider = {
    id: "provider-1",
    displayName: "Dr Test",
    description: null,
    email: null,
    phone: null,
    timezone: "Europe/Budapest",
    languages: ["en"],
    active: true,
    onlineBookingEnabled: true,
    autoConfirmBookings: false,
    minimumNoticeMinutes: null,
    maximumAdvanceDays: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  await page.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json:
        path === "/v1/me"
          ? {
              user: {
                id: "user-1",
                name: "Provider",
                email: "provider@example.test",
                isPlatformAdmin: false,
              },
              tenant,
              membership: { id: "member-1", role: "PROVIDER", providerId: "provider-1" },
              permissions: ["tenant:read", "availability:manage:own"],
              features: { assistant: false },
              delegations: [],
            }
          : path === "/v1/tenants"
            ? { items: [tenant] }
            : path === "/v1/providers/provider-1"
              ? provider
              : path === "/v1/providers/provider-1/working-hours"
                ? { items: [], lastChange: null, fingerprint: "empty-week" }
                : { items: [], nextCursor: null },
    });
  });

  await page.goto("/en/dashboard/availability");
  const hours = page.getByRole("tab", { name: "Weekly working hours" });
  await expect(hours).toHaveAttribute("aria-selected", "true");
  // A provider sees who assists them, so all three tabs are offered.
  await expect(page.getByRole("tab")).toHaveCount(3);

  // Scoped to the hours panel — the Exceptions tab has a "From" field too —
  // and `includeHidden`, so the row can be counted while its tab is hidden.
  const hoursPanel = page.getByRole("tabpanel", {
    name: "Weekly working hours",
    includeHidden: true,
  });
  const from = hoursPanel.getByRole("textbox", { name: "From", includeHidden: true });
  await expect(from).toHaveCount(0);
  await page.getByRole("button", { name: "Add period" }).first().click();
  await expect(from).toHaveCount(1);

  await page.getByRole("tab", { name: "Exceptions" }).click();
  await expect(hoursPanel).toBeHidden();
  await expect(from).toHaveCount(1);
  await hours.click();
  await expect(from).toHaveCount(1);
  await expect(from).toBeVisible();
});
