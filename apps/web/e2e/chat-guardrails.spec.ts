import { expect, test } from "@playwright/test";

const translations = {
  en: {
    start: "Start chat",
    goodbye: "Thank you for chatting with us.",
    paste: "Please type your message.",
    warning: "One minute remaining.",
  },
  hu: {
    start: "Beszélgetés indítása",
    goodbye: "Köszönjük a beszélgetést!",
    paste: "Kérjük, gépelje be az üzenetet.",
    warning: "Egy perc van hátra.",
  },
  de: {
    start: "Chat starten",
    goodbye: "Vielen Dank für das Gespräch.",
    paste: "Bitte tippen Sie Ihre Nachricht.",
    warning: "Noch eine Minute.",
  },
  fr: {
    start: "Démarrer le chat",
    goodbye: "Merci pour cet échange.",
    paste: "Veuillez saisir votre message.",
    warning: "Il reste une minute.",
  },
};

for (const locale of ["hu", "en", "de", "fr"] as const) {
  test(`${locale}: explicit start, paste/drop protection, refresh, countdown and closure`, async ({
    page,
  }) => {
    let starts = 0;
    let expired = false;
    const expiresAt = new Date(Date.now() + 900_000).toISOString();
    const turn = () => ({
      conversationId: "test-conversation",
      state: expired ? "EXPIRED" : "START",
      status: expired ? "EXPIRED" : "ACTIVE",
      expiresAt,
      maxMessageCharacters: 500,
      charactersRemaining: 5000,
      closureReason: expired ? "TIME_LIMIT" : null,
      turnsRemaining: 40,
      message: { key: expired ? "conversation.goodbye" : "conversation.greeting", ui: "NONE" },
      confirmation: null,
      bookingReference: null,
    });
    await page.route("**/v1/public/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/assistant")) {
        await route.fulfill({
          json: {
            available: true,
            personaName: "Reception",
            branding: { businessName: "Test Clinic" },
            supportedLocales: ["hu", "en", "de", "fr"],
          },
        });
      } else if (path.endsWith("/tenants/guardrail-test/conversations")) {
        starts++;
        expect(route.request().headers()["idempotency-key"]).toBeTruthy();
        await route.fulfill({
          status: 201,
          json: { ...turn(), sessionToken: "test-session-token" },
        });
      } else {
        await route.fulfill({
          json: {
            ...turn(),
            messages: [
              {
                id: "greeting",
                sender: "ASSISTANT",
                content: "conversation.greeting",
                spoken: false,
                createdAt: new Date().toISOString(),
              },
            ],
          },
        });
      }
    });
    await page.clock.install();
    await page.goto("/en/guardrail-test/chat?parentOrigin=http%3A%2F%2Flocalhost%3A3110");
    await page.getByRole("combobox").selectOption(locale);
    const copy = translations[locale];
    const start = page.getByRole("button", { name: copy.start, exact: true });
    await expect(start).toBeEnabled();
    expect(starts).toBe(0);
    await expect(page.locator("#chat-message")).toBeDisabled();
    await start.click();
    await expect(page.locator("#chat-message")).toBeEnabled();
    expect(starts).toBe(1);
    await page.locator("#chat-message").fill("A normal typed message");
    await page.locator("#chat-message").evaluate((element) => {
      const data = new DataTransfer();
      data.setData("text/plain", "pasted content");
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
      );
      element.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }),
      );
    });
    await expect(page.getByRole("alert").filter({ hasText: copy.paste })).toBeVisible();
    await expect(page.locator("#chat-message")).toHaveValue("A normal typed message");
    await page.reload();
    await page.getByRole("combobox").selectOption(locale);
    await expect(page.locator("#chat-message")).toBeEnabled();
    expect(starts).toBe(1);
    await page.clock.runFor(841_000);
    await expect(page.getByText(copy.warning, { exact: true })).toBeVisible();
    expired = true;
    await page.clock.runFor(60_000);
    await expect(page.locator("#chat-message")).toBeDisabled();
    await expect(page.getByText(copy.goodbye, { exact: false })).toBeVisible();
    await expect(page.locator('a[href$="/guardrail-test/book"]')).toBeVisible();
    expect(starts).toBe(1);
  });
}
