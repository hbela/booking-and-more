import { randomUUID } from "node:crypto";
import type { Request, Response } from "@playwright/test";
import type {
  ConversationTurn,
  ReplayedConversation,
  StartedConversation,
} from "../src/lib/conversation-client";
import { allowWrites, apiOrigin, call, expect, key, tenantPreflight, test } from "./fixtures";

const isResponse =
  (path: string, method = "GET") =>
  (response: Response) =>
    new URL(response.url()).pathname === path && response.request().method() === method;

function assertApi(response: Response): void {
  expect(new URL(response.url()).origin, "Frontend must use the staging API").toBe(apiOrigin);
  expect(response.status()).toBe(200);
}

function streamEvents(stream: string): { event: string; data: unknown }[] {
  return stream
    .trim()
    .split(/\r?\n\r?\n/u)
    .map((block) => {
      const lines = block.split(/\r?\n/u);
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
      const data = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      return { event, data: JSON.parse(data) as unknown };
    });
}

interface Booking {
  managementToken: string;
  reference: string;
  status: string;
  tenantSlug: string;
  customerName: string;
  startAt: string;
}

test("preflight: dedicated tenant, bookable catalogue and assistant are available", async ({
  live,
}) => {
  const { api, config } = live;
  await tenantPreflight(api, config.slug);
  const root = `/v1/public/tenants/${config.slug}`;
  const services = await call(api, "GET", `${root}/services?locale=en&limit=100`, 200);
  expect(((await services.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
  const assistant = await call(api, "GET", `${root}/assistant`, 200);
  expect(((await assistant.json()) as { available: boolean }).available).toBe(true);
});

test("booking: browser confirmation persists, retries replay, and cancellation persists", async ({
  page,
  live,
}) => {
  allowWrites();
  const { api, config } = live;
  await tenantPreflight(api, config.slug);
  const root = `/v1/public/tenants/${config.slug}`;
  const serviceResponse = await call(api, "GET", `${root}/services?locale=en&limit=100`, 200);
  const services = ((await serviceResponse.json()) as { items: { id: string; name: string }[] })
    .items;
  const service = services.find((item) => !config.serviceId || item.id === config.serviceId);
  if (!service)
    throw new Error("The test tenant needs a public service matching STAGING_E2E_SERVICE_ID.");
  const providerResponse = await call(
    api,
    "GET",
    `${root}/providers?serviceId=${service.id}&limit=100`,
    200,
  );
  const providers = (
    (await providerResponse.json()) as { items: { id: string; displayName: string }[] }
  ).items;
  const provider = providers.find((item) => !config.providerId || item.id === config.providerId);
  if (!provider)
    throw new Error("The test service needs a public provider matching STAGING_E2E_PROVIDER_ID.");

  // A week ahead keeps cleanup outside ordinary short-notice cancellation windows.
  const dateFrom = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const dateTo = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
  const slotResponse = await call(api, "POST", `${root}/slots/search`, 200, {
    data: { serviceId: service.id, providerId: provider.id, dateFrom, dateTo },
  });
  const slot = ((await slotResponse.json()) as { items: { startAt: string }[] }).items[0];
  if (!slot) throw new Error("The test provider needs availability 7 to 21 days from now.");

  let hold: { id: string; sessionId: string } | undefined;
  let submitted: Request | undefined;
  let booking: Booking | undefined;
  const name = `E2E ${randomUUID()}`;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `${root}/bookings`) {
      submitted = request;
    }
  });

  try {
    const catalogueLoaded = page.waitForResponse(isResponse(`${root}/services`));
    await page.goto(`/en/${config.slug}/book`);
    assertApi(await catalogueLoaded);
    // Tenant pages initially prefer the clinic's language over the URL locale.
    await page
      .getByRole("combobox")
      .filter({ has: page.locator('option[value="en"]') })
      .selectOption("en");
    await expect(page.getByRole("combobox", { name: "Language", exact: true })).toHaveValue("en");
    await page.getByRole("button").filter({ hasText: service.name }).first().click();
    await page.getByRole("button").filter({ hasText: provider.displayName }).first().click();
    await expect(page.getByRole("grid")).toHaveAttribute("aria-busy", "false");
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Budapest" }).format(
      new Date(slot.startAt),
    );
    // The calendar groups and displays slots in the browser's timezone.
    for (let month = 0; month < 3; month++) {
      const dayButton = page.locator(`button[data-date="${day}"]`);
      if (await dayButton.count()) break;
      await page.getByRole("button", { name: "Next month", exact: true }).click();
      await expect(page.getByRole("grid")).toHaveAttribute("aria-busy", "false");
    }
    await page.locator(`button[data-date="${day}"]`).click();
    const held = page.waitForResponse(isResponse(`${root}/holds`, "POST"));
    await page
      .locator("button")
      .filter({ has: page.locator(`time[datetime="${slot.startAt}"]`) })
      .click();
    const heldResponse = await held;
    const heldBody = (await heldResponse.json()) as { id: string };
    if (heldBody.id)
      hold = {
        id: heldBody.id,
        sessionId: (heldResponse.request().postDataJSON() as { sessionId: string }).sessionId,
      };
    expect(heldResponse.status()).toBe(201);
    await page.locator("#full-name").fill(name);
    await page.locator("#email").fill(config.email);
    await page.locator("#notes").fill("Automated staging check; cancelled by test cleanup.");
    const confirmed = page.waitForResponse(isResponse(`${root}/bookings`, "POST"));
    await page.locator('form button[type="submit"]').click();
    const confirmedResponse = await confirmed;
    booking = (await confirmedResponse.json()) as Booking;
    expect(confirmedResponse.status()).toBe(201);
    expect(Boolean(booking.managementToken), "Confirmation includes a management credential").toBe(
      true,
    );
    await expect(page.getByText(booking.reference, { exact: true })).toBeVisible();

    const retry = await call(api, "POST", `${root}/bookings`, 201, {
      data: submitted!.postDataJSON(),
      headers: { "Idempotency-Key": submitted!.headers()["idempotency-key"]! },
    });
    const repeated = (await retry.json()) as Booking;
    expect(repeated.reference).toBe(booking.reference);
    expect(
      repeated.managementToken === booking.managementToken,
      "Retry replays the same booking credential",
    ).toBe(true);
    const persisted = await call(api, "GET", `/v1/public/bookings/${booking.managementToken}`, 200);
    expect(await persisted.json()).toMatchObject({
      reference: booking.reference,
      tenantSlug: config.slug,
      customerName: name,
      startAt: slot.startAt,
    });
    await call(api, "GET", `/v1/public/bookings/${randomUUID()}${randomUUID()}`, 404);
  } finally {
    // Leave time for cleanup even when a UI assertion consumed the test deadline.
    test.setTimeout(test.info().timeout + 60_000);
    // Recover the management credential if the browser lost the confirmation response.
    if (!booking?.managementToken && submitted) {
      const recovered = await call(api, "POST", `${root}/bookings`, 201, {
        data: submitted.postDataJSON(),
        headers: { "Idempotency-Key": submitted.headers()["idempotency-key"]! },
      });
      booking = (await recovered.json()) as Booking;
    }
    if (booking?.managementToken) {
      await test.step("cleanup: cancel only this run's booking and verify the stored status", async () => {
        const path = `/v1/public/bookings/${booking!.managementToken}`;
        const preview = await call(api, "POST", `${path}/cancel/prepare`, 200);
        expect(
          ((await preview.json()) as { allowed: boolean }).allowed,
          "Test tenant must permit cancellation a week ahead",
        ).toBe(true);
        const headers = key();
        const data = { reason: "Automated staging test cleanup" };
        await call(api, "POST", `${path}/cancel/confirm`, 200, { headers, data });
        await call(api, "POST", `${path}/cancel/confirm`, 200, { headers, data });
        const cancelled = await call(api, "GET", path, 200);
        expect(((await cancelled.json()) as Booking).status).toBe("CANCELLED");
      });
    }
    if (hold && !booking?.managementToken)
      await call(
        api,
        "DELETE",
        `${root}/holds/${hold.id}?sessionId=${encodeURIComponent(hold.sessionId)}`,
        204,
      );
  }
});

test("chat: explicit start, replay, rejected oversize input and one idempotent real AI turn", async ({
  page,
  live,
}) => {
  allowWrites();
  const { api, config } = live;
  await tenantPreflight(api, config.slug);
  const root = `/v1/public/tenants/${config.slug}`;
  let starts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `${root}/conversations`)
      starts++;
  });
  const available = page.waitForResponse(isResponse(`${root}/assistant`));
  await page.goto(`/en/${config.slug}/chat`);
  assertApi(await available);
  await page.getByRole("combobox").selectOption("en");
  await expect(page.getByRole("button", { name: "Start chat", exact: true })).toBeEnabled();
  expect(starts).toBe(0);
  await expect(page.locator("#chat-message")).toBeDisabled();
  const created = page.waitForResponse(isResponse(`${root}/conversations`, "POST"));
  await page.getByRole("button", { name: "Start chat", exact: true }).click();
  const createdResponse = await created;
  expect(createdResponse.status()).toBe(201);
  const session = (await createdResponse.json()) as StartedConversation;
  const path = `/v1/public/conversations/${session.conversationId}`;
  const headers = { "X-Conversation-Token": session.sessionToken };
  const retry = await call(api, "POST", `${root}/conversations`, 201, {
    data: createdResponse.request().postDataJSON(),
    headers: { "Idempotency-Key": createdResponse.request().headers()["idempotency-key"]! },
  });
  const repeated = (await retry.json()) as StartedConversation;
  expect(repeated.conversationId).toBe(session.conversationId);
  expect(
    repeated.sessionToken === session.sessionToken,
    "Start retry returns the original credential",
  ).toBe(true);
  expect(repeated.expiresAt).toBe(session.expiresAt);
  await call(api, "GET", path, 404, { headers: { "X-Conversation-Token": randomUUID() } });

  const initial = (await (
    await call(api, "GET", path, 200, { headers })
  ).json()) as ReplayedConversation;
  await call(api, "POST", `${path}/messages`, 400, {
    headers: { ...headers, ...key() },
    data: { text: "x".repeat(session.maxMessageCharacters + 1) },
  });
  const rejected = (await (
    await call(api, "GET", path, 200, { headers })
  ).json()) as ReplayedConversation;
  expect(rejected.charactersRemaining).toBe(initial.charactersRemaining);
  expect(rejected.messages.length).toBe(initial.messages.length);

  const message = "Hello! Please list the services available. Do not make a booking.";
  await page.locator("#chat-message").fill(message);
  const answered = page.waitForResponse(isResponse(`${path}/messages`, "POST"), {
    timeout: 70_000,
  });
  await page.locator("#chat-message").press("Enter");
  const answeredResponse = await answered;
  expect(answeredResponse.status()).toBe(200);
  const stream = await answeredResponse.text();
  const completion = stream
    .split(/\r?\n\r?\n/u)
    .find((block) => block.startsWith("event: completion\n"));
  expect(Boolean(completion), "Assistant stream includes a completed turn").toBe(true);
  const turn = JSON.parse(completion!.split("\ndata: ")[1]!) as ConversationTurn;
  expect(turn.closureReason).toBeNull();
  expect(turn.bookingReference).toBeNull();
  expect(turn.confirmation).toBeNull();
  expect(turn.charactersRemaining).toBe(initial.charactersRemaining - Array.from(message).length);
  expect(turn.expiresAt).toBe(session.expiresAt);
  const after = (await (
    await call(api, "GET", path, 200, { headers })
  ).json()) as ReplayedConversation;
  expect(
    after.messages.filter((item) => item.sender === "CUSTOMER" && item.content === message),
  ).toHaveLength(1);
  expect(after.messages.filter((item) => item.sender === "ASSISTANT").length).toBeGreaterThan(
    initial.messages.filter((item) => item.sender === "ASSISTANT").length,
  );
  const messageRetry = await call(api, "POST", `${path}/messages`, 200, {
    headers: {
      ...headers,
      "Idempotency-Key": answeredResponse.request().headers()["idempotency-key"]!,
    },
    data: answeredResponse.request().postDataJSON(),
  });
  // PostgreSQL JSONB can reorder object keys in the cached result.
  expect(streamEvents(await messageRetry.text()), "Message retry replays the same events").toEqual(
    streamEvents(stream),
  );
  const retried = (await (
    await call(api, "GET", path, 200, { headers })
  ).json()) as ReplayedConversation;
  expect(retried.messages).toEqual(after.messages);
  expect(retried.charactersRemaining).toBe(after.charactersRemaining);
  const replayed = page.waitForResponse(isResponse(path));
  await page.reload();
  assertApi(await replayed);
  await expect(page.locator("#chat-message")).toBeEnabled();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  expect(starts).toBe(1);
  // No close-session API exists. This synthetic session expires normally;
  // its allowance is intentionally not refunded or deleted by this suite.
});
