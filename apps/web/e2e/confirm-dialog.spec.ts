import { expect, test } from "@playwright/test";

// useConfirm replaced window.confirm() (phase-11-shadcn-adoption §3.7). The
// browser's dialog was modal by construction; this one has to earn it: declining
// must send nothing, confirming must send exactly once, and focus must come back
// to the row button that asked.
test("archiving a provider asks first, in the page's own dialog", async ({ page }) => {
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
  const deletes: string[] = [];
  page.on("dialog", () => {
    throw new Error("a native browser dialog opened; useConfirm should have been used");
  });

  await page.route("**/v1/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "DELETE") {
      deletes.push(path);
      return route.fulfill({ status: 204 });
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
              tenant,
              membership: { id: "member-1", role: "OWNER", providerId: null },
              permissions: ["tenant:read", "provider:manage"],
              features: { assistant: false },
              delegations: [],
            }
          : path === "/v1/tenants"
            ? { items: [tenant] }
            : path === "/v1/providers"
              ? { items: [provider], nextCursor: null }
              : { items: [], nextCursor: null },
    });
  });

  await page.goto("/en/dashboard/providers");
  const archive = page.getByRole("button", { name: "Archive", exact: true });
  await archive.click();

  const dialog = page.getByRole("alertdialog", { name: /^Archive Dr Test\?/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(archive).toBeFocused();
  expect(deletes).toEqual([]);

  await archive.click();
  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => deletes).toEqual(["/v1/providers/provider-1"]);
});
