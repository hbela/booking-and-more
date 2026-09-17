import { expect, test, type Page } from "@playwright/test";

const managementToken = "test-booking-management-token";

async function mockBooking(page: Page, available = true, failStart = false) {
  const starts: Array<{ managementToken: string; locale: string }> = [];
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/v1/public/bookings/${managementToken}`) {
      return route.fulfill({
        json: {
          tenantSlug: "wellness-demo",
          reference: "ZLTJQ9",
          status: "CONFIRMED",
          startAt: "2026-09-18T07:00:00Z",
          endAt: "2026-09-18T07:30:00Z",
          serviceName: "Dentálhigiénia",
          providerName: "Dr. Kiss Katalin",
          locationName: null,
          priceMinor: null,
          currency: null,
          customerName: "Test Customer",
          cancellationPolicy: null,
        },
      });
    }
    if (path.endsWith("/assistant")) {
      return route.fulfill({
        json: {
          available,
          personaName: "Assistant",
          greeting: "Hello",
          supportedLocales: ["hu", "en"],
          branding: { businessName: "Wellness Demo", logoUrl: null },
        },
      });
    }
    if (path.endsWith("/conversations") && route.request().method() === "POST") {
      starts.push(route.request().postDataJSON() as { managementToken: string; locale: string });
      if (failStart)
        return route.fulfill({
          status: 503,
          json: {
            error: { code: "CONVERSATION_UNAVAILABLE", message: "Unavailable" },
          },
        });
      return route.fulfill({
        status: 201,
        json: {
          conversationId: "booking-chat",
          sessionToken: "test-session-token",
          expiresAt: "2026-09-18T08:00:00Z",
          state: "IDLE",
          status: "ACTIVE",
          message: { key: "conversation.greeting", ui: "NONE" },
          confirmation: null,
          bookingReference: "ZLTJQ9",
          turnsRemaining: 20,
        },
      });
    }
    // A management chat must never replay an unrelated saved conversation.
    return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
  });
  return starts;
}

test("opens Hungarian chat for this booking and keeps its context on reset", async ({ page }) => {
  const starts = await mockBooking(page);
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "bam.chat.wellness-demo.hu",
      JSON.stringify({ id: "unrelated", token: "old" }),
    );
  });
  await page.goto(`/hu/booking/manage/${managementToken}`);
  const button = page.getByRole("button", { name: "Kérdezze az asszisztenst" });
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const chat = page.getByRole("region", { name: "AI Asszistens" });
  await expect(chat).toBeVisible();
  await expect(chat.getByText("Üdvözlöm! Miben segíthetek?", { exact: true })).toBeVisible();
  expect(starts).toEqual([expect.objectContaining({ managementToken, locale: "hu" })]);
  await chat.getByRole("button", { name: "Új beszélgetés" }).click();
  await expect.poll(() => starts.length).toBe(2);
  expect(starts[1]).toMatchObject({ managementToken, locale: "hu" });
  await button.click();
  await expect(chat).toHaveCount(0);
});

test("starts in English and preserves the booking when switching chat language", async ({
  page,
}) => {
  const starts = await mockBooking(page);
  await page.goto(`/en/booking/manage/${managementToken}`);
  await page.getByRole("button", { name: "Ask the assistant" }).click();
  await expect(page.getByText("Hello! How can I help?", { exact: true })).toBeVisible();
  expect(starts[0]).toMatchObject({ managementToken, locale: "en" });
  await page.getByRole("combobox", { name: "Language" }).selectOption("hu");
  await expect(page.getByText("Üdvözlöm! Miben segíthetek?", { exact: true })).toBeVisible();
  expect(starts[1]).toMatchObject({ managementToken, locale: "hu" });
});

test("shows chat startup failures and leaves booking actions available", async ({ page }) => {
  await mockBooking(page, true, true);
  await page.goto(`/en/booking/manage/${managementToken}`);
  await page.getByRole("button", { name: "Ask the assistant" }).click();
  await expect(
    page.getByText("The AI Assistant is unavailable. The booking form still works."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Change the time", exact: true })).toBeEnabled();
});

test("does not offer assistant chat when the API reports it unavailable", async ({ page }) => {
  await mockBooking(page, false);
  const availability = page.waitForResponse("**/wellness-demo/assistant");
  await page.goto(`/en/booking/manage/${managementToken}`);
  await availability;
  await expect(page.getByRole("button", { name: "Change the time", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask the assistant" })).toHaveCount(0);
});
