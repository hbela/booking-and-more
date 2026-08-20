import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envelope, fakeProviders, type FakeProviders } from "@bam/ai";
import { loadEnv } from "@bam/config";

import { buildApp, type AppInstance } from "./app.js";

/**
 * Epic 7 through real HTTP. docs/phase-7-chat-booking.md.
 *
 * The interpreter is scripted (`@bam/ai`'s `fakeProviders`), so what is under
 * test is never the model's accuracy — which no test can hold still — but
 * everything around it: that a validated envelope reaches the same
 * `BookingService` the form uses, that an intent with no handler cannot run,
 * that a "yes" only ever confirms a named action, that a token opens exactly one
 * conversation, and that none of it crosses a tenant boundary.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];

const RUN = `cv${randomBytes(4).toString("hex")}`;

/** A Monday far enough ahead to clear any default booking window. */
const MONDAY = "2026-09-07";

/**
 * The turn payload, as the panel sees it.
 *
 * Declared by hand rather than imported from the route's Zod schema, on purpose:
 * a test that asserts against the same type the handler returns proves the
 * handler agrees with itself. This is the client's view.
 */
interface TurnBody {
  conversationId: string;
  state: string;
  status: string;
  message: { key: string; params?: Record<string, string | number> };
  services?: { id: string; name: string }[];
  providers?: { id: string; displayName: string }[];
  slots?: { providerId: string; providerName: string; startAt: string; endAt: string }[];
  confirmation: {
    actionId: string;
    tool: string;
    serviceName: string;
    providerName: string;
    startAt: string;
    priceMinor: number | null;
    currency: string | null;
    customerName: string | null;
  } | null;
  bookingReference: string | null;
  turnsRemaining: number;
  messages?: { id: string; sender: string; content: string; spoken: boolean }[];
  sessionToken?: string;
}

describe.skipIf(!databaseUrl)("conversational booking", () => {
  let app: AppInstance;
  let ai: FakeProviders;

  beforeAll(async () => {
    const env = loadEnv({
      source: {
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        APP_BASE_URL: "http://localhost:3000",
        API_BASE_URL: "http://localhost:3001",
        DATABASE_URL: databaseUrl!,
        BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
      },
      loadDotenvFile: false,
    });

    ai = fakeProviders();

    app = await buildApp({ env, logger: false, rateLimit: false, aiProviders: ai });
    await app.ready();
  });

  afterAll(async () => {
    const tenants = await app.prisma.tenant.findMany({
      where: { slug: { endsWith: RUN } },
      select: { id: true },
    });
    const tenantIds = tenants.map((tenant) => tenant.id);

    if (tenantIds.length > 0) {
      const where = { tenantId: { in: tenantIds } };
      await app.prisma.conversationPendingAction.deleteMany({ where });
      await app.prisma.conversationMessage.deleteMany({ where });
      await app.prisma.conversationSession.deleteMany({ where });
      await app.prisma.usageEvent.deleteMany({ where });
      await app.prisma.usageAggregate.deleteMany({ where });
      await app.prisma.capacityReservation.deleteMany({ where });
      await app.prisma.booking.deleteMany({ where });
      await app.prisma.bookingHold.deleteMany({ where });
      await app.prisma.customer.deleteMany({ where });
      await app.prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }

    await app.prisma.user.deleteMany({ where: { email: { endsWith: `${RUN}@example.test` } } });
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Harness
  // -------------------------------------------------------------------------

  async function signUp(label: string): Promise<{ cookie: string; id: string }> {
    const email = `${label}-${RUN}@example.test`;

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: { email, password: "correct-horse-battery-staple", name: label },
    });
    expect(response.statusCode, response.body).toBeLessThan(400);

    const setCookie = response.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
    const cookie = cookies
      .map((entry) => entry.split(";")[0])
      .filter(Boolean)
      .join("; ");

    const user = await app.prisma.user.findUnique({ where: { email } });
    return { cookie, id: user!.id };
  }

  function as(cookie: string, tenantId?: string) {
    return { cookie, ...(tenantId === undefined ? {} : { "x-tenant-id": tenantId }) };
  }

  function key(): Record<string, string> {
    return { "idempotency-key": randomBytes(12).toString("hex") };
  }

  interface Clinic {
    tenantId: string;
    slug: string;
    providerId: string;
    serviceId: string;
    ownerCookie: string;
  }

  /** A clinic in UTC with one provider working Monday 09:00-17:00. */
  async function clinic(label: string): Promise<Clinic> {
    const owner = await signUp(label);
    const slug = `${label}-${RUN}`;

    const tenantResponse = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: as(owner.cookie),
      payload: { name: label, slug, defaultTimezone: "UTC", defaultLanguage: "en" },
    });
    expect(tenantResponse.statusCode, tenantResponse.body).toBe(201);
    const tenantId = tenantResponse.json().id as string;

    const create = async (url: string, payload: Record<string, unknown>): Promise<string> => {
      const response = await app.inject({
        method: "POST",
        url,
        headers: as(owner.cookie, tenantId),
        payload,
      });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(201);
      return response.json().id as string;
    };

    const providerId = await create("/v1/providers", {
      displayName: "Dr. Kovács Anna",
      email: `anna-${label}@example.test`,
      timezone: "UTC",
    });
    const serviceId = await create("/v1/services", {
      name: "Dental check-up",
      durationMinutes: 60,
      priceMinor: 15_000,
      currency: "HUF",
    });

    await app.inject({
      method: "PUT",
      url: `/v1/providers/${providerId}/services`,
      headers: as(owner.cookie, tenantId),
      payload: { services: [{ serviceId }] },
    });

    const currentHours = await app.inject({
      method: "GET",
      url: `/v1/providers/${providerId}/working-hours`,
      headers: as(owner.cookie, tenantId),
    });
    expect(currentHours.statusCode, currentHours.body).toBe(200);

    const hours = await app.inject({
      method: "PUT",
      url: `/v1/providers/${providerId}/working-hours`,
      headers: as(owner.cookie, tenantId),
      payload: {
        workingHours: [{ weekday: 1, startTime: "09:00", endTime: "17:00" }],
        expectedFingerprint: currentHours.json().fingerprint as string,
      },
    });
    expect(hours.statusCode, hours.body).toBe(200);

    await app.prisma.tenantAssistantSettings.upsert({
      where: { tenantId },
      create: { tenantId, enabled: true, supportedLocales: ["en", "hu"] },
      update: { enabled: true, supportedLocales: ["en", "hu"] },
    });
    await app.prisma.subscription.upsert({
      where: { tenantId },
      create: { tenantId, plan: "INTERNAL", status: "NOT_APPLICABLE" },
      update: { plan: "INTERNAL", status: "NOT_APPLICABLE" },
    });

    return { tenantId, slug, providerId, serviceId, ownerCookie: owner.cookie };
  }

  async function startConversation(site: Clinic, channel: "CHAT" | "VOICE" = "CHAT") {
    const response = await app.inject({
      method: "POST",
      url: `/v1/public/tenants/${site.slug}/conversations`,
      payload: { channel, locale: "en", timezone: "UTC" },
    });

    expect(response.statusCode, response.body).toBe(201);
    const body = response.json<TurnBody>();

    return {
      id: body.conversationId,
      token: body.sessionToken as string,
      body,
      headers: { "x-conversation-token": body.sessionToken as string },
    };
  }

  async function say(
    conversation: { id: string; headers: Record<string, string> },
    text: string,
    spoken = false,
  ) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/public/conversations/${conversation.id}/messages`,
      headers: { ...conversation.headers, origin: "http://localhost:3000" },
      payload: { text, spoken },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    const completion = response.body
      .split(/\r?\n\r?\n/u)
      .find((block) => block.startsWith("event: completion"));
    const data = completion?.split(/\r?\n/u).find((line) => line.startsWith("data: "));
    if (!data) throw new Error(`Missing SSE completion: ${response.body}`);
    return JSON.parse(data.slice(6)) as TurnBody;
  }

  /**
   * Walk a conversation from nothing to a confirmation card.
   *
   * The scripted envelopes are the four turns a real customer takes: name the
   * service, ask for a time, pick one, give their details.
   */
  async function upToConfirmation(site: Clinic, channel: "CHAT" | "VOICE" = "CHAT") {
    const conversation = await startConversation(site, channel);

    ai.interpreter.push(
      envelope({
        intent: "SEARCH_SLOTS",
        parameters: { serviceQuery: "dental check-up", dateExpression: "2026-09-07" },
      }),
    );
    const searched = await say(conversation, "I need a dental check-up on the 7th");
    const offered = searched.slots ?? [];
    expect(offered.length, JSON.stringify(searched)).toBeGreaterThan(0);

    ai.interpreter.push(envelope({ intent: "SELECT_SLOT", parameters: { slotOrdinal: 1 } }));
    const selected = await say(conversation, "the first one");
    expect(selected.state).toBe("COLLECTING_CUSTOMER_DETAILS");

    ai.interpreter.push(
      envelope({
        intent: "CREATE_BOOKING",
        requiresConfirmation: true,
        parameters: { fullName: "Nagy Péter", email: "nagy.peter@example.test" },
      }),
    );
    const prepared = await say(conversation, "Nagy Péter, nagy.peter@example.test");
    const confirmation = prepared.confirmation;

    expect(confirmation, JSON.stringify(prepared)).not.toBeNull();

    return { conversation, prepared, confirmation: confirmation!, firstSlot: offered[0]! };
  }

  // -------------------------------------------------------------------------
  // The happy path
  // -------------------------------------------------------------------------

  it("books through the same engine the form uses", async () => {
    const site = await clinic("happy");
    const { conversation, prepared, confirmation } = await upToConfirmation(site);

    // The card carries an absolute instant, never "tomorrow" (PRD §10.2).
    expect(prepared.state).toBe("AWAITING_CONFIRMATION");
    expect(prepared.confirmation).toMatchObject({
      tool: "confirmBooking",
      serviceName: "Dental check-up",
      providerName: "Dr. Kovács Anna",
      priceMinor: 15_000,
      currency: "HUF",
      customerName: "Nagy Péter",
    });
    expect(Date.parse(confirmation.startAt)).toBeGreaterThan(0);

    const confirmed = await app.inject({
      method: "POST",
      url: `/v1/public/conversations/${conversation.id}/actions/${confirmation.actionId}/confirm`,
      headers: { ...conversation.headers, ...key() },
    });

    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json<TurnBody>().status).toBe("COMPLETED");
    expect(confirmed.json<TurnBody>().bookingReference).toBeTruthy();

    const booking = await app.prisma.booking.findFirst({
      where: { tenantId: site.tenantId, reference: confirmed.json<TurnBody>().bookingReference! },
    });

    // The first code path in the product to set this. The enum has existed
    // unused since the booking engine landed.
    expect(booking?.source).toBe("CHAT");
    // Rule 15: the snapshot is what the customer was told, taken at confirmation.
    expect(booking?.serviceNameSnapshot).toBe("Dental check-up");
    expect(booking?.priceMinorSnapshot).toBe(15_000);
    expect(booking?.customerNameSnapshot).toBe("Nagy Péter");
  });

  it("rejects the excluded voice channel", async () => {
    const site = await clinic("spoken");
    const response = await app.inject({
      method: "POST",
      url: `/v1/public/tenants/${site.slug}/conversations`,
      payload: { channel: "VOICE", locale: "en", timezone: "UTC" },
    });
    expect(response.statusCode).toBe(422);
  });

  it("removes the slot it holds from the next stranger's search", async () => {
    const site = await clinic("holds");
    const { firstSlot } = await upToConfirmation(site);

    const search = await app.inject({
      method: "POST",
      url: `/v1/public/tenants/${site.slug}/slots/search`,
      payload: { serviceId: site.serviceId, dateFrom: MONDAY, dateTo: MONDAY },
    });

    const offered = search
      .json<{ items: { startAt: string }[] }>()
      .items.map((slot) => slot.startAt);
    expect(offered).not.toContain(firstSlot.startAt);
  });

  // -------------------------------------------------------------------------
  // Confirmation is a named action, never a sentence
  // -------------------------------------------------------------------------

  it("refuses a second confirmation of the same action", async () => {
    const site = await clinic("twice");
    const { conversation, confirmation } = await upToConfirmation(site);
    const url = `/v1/public/conversations/${conversation.id}/actions/${confirmation.actionId}/confirm`;

    const first = await app.inject({
      method: "POST",
      url,
      headers: { ...conversation.headers, ...key() },
    });
    expect(first.json<TurnBody>().status).toBe("COMPLETED");

    // A double-tap must not be a double booking. A fresh idempotency key, so it
    // is the pending action doing the refusing rather than the key table.
    const second = await app.inject({
      method: "POST",
      url,
      headers: { ...conversation.headers, ...key() },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<TurnBody>().message.key).toBe("conversation.error.alreadyConfirmed");

    const bookings = await app.prisma.booking.count({ where: { tenantId: site.tenantId } });
    expect(bookings).toBe(1);
  });

  it("refuses an action from another conversation", async () => {
    const site = await clinic("elsewhere");
    const { confirmation } = await upToConfirmation(site);
    const other = await startConversation(site);

    const response = await app.inject({
      method: "POST",
      url: `/v1/public/conversations/${other.id}/actions/${confirmation.actionId}/confirm`,
      headers: { ...other.headers, ...key() },
    });

    expect(response.json<TurnBody>().message.key).toBe("conversation.error.alreadyConfirmed");
    expect(await app.prisma.booking.count({ where: { tenantId: site.tenantId } })).toBe(0);
  });

  it("has no endpoint meaning 'confirm whatever we were discussing'", async () => {
    const site = await clinic("unnamed");
    const { conversation } = await upToConfirmation(site);

    // A bare "yes" is a message like any other. Whatever it interprets to, it
    // does not reach the confirm route — that needs an action id in its path.
    ai.interpreter.push(envelope({ intent: "CREATE_BOOKING", requiresConfirmation: true }));
    await say(conversation, "yes");

    expect(await app.prisma.booking.count({ where: { tenantId: site.tenantId } })).toBe(0);
  });

  it("withdraws an action when the customer changes their mind", async () => {
    const site = await clinic("nevermind");
    const { conversation, confirmation } = await upToConfirmation(site);

    const cancelled = await app.inject({
      method: "POST",
      url: `/v1/public/conversations/${conversation.id}/actions/${confirmation.actionId}/cancel`,
      headers: conversation.headers,
    });

    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json<TurnBody>().state).toBe("SELECTING_SLOT");

    const retried = await app.inject({
      method: "POST",
      url: `/v1/public/conversations/${conversation.id}/actions/${confirmation.actionId}/confirm`,
      headers: { ...conversation.headers, ...key() },
    });

    expect(retried.json<TurnBody>().message.key).toBe("conversation.error.alreadyConfirmed");
  });

  // -------------------------------------------------------------------------
  // The allowlist
  // -------------------------------------------------------------------------

  it("refuses an intent that has no handler", async () => {
    const site = await clinic("allowlist");
    const conversation = await startConversation(site);

    // Declared in the envelope's enum because tech-impl §21 declares one enum;
    // absent from the customer allowlist, so it cannot run (PRD §13.5).
    ai.interpreter.push(
      envelope({ intent: "BLOCK_TIME", requiresConfirmation: true, confidence: 0.99 }),
    );

    const turn = await say(conversation, "block Friday afternoon");

    expect(turn.message.key).toBe("conversation.error.outOfScope");
    expect(
      await app.prisma.availabilityException.count({ where: { tenantId: site.tenantId } }),
    ).toBe(0);
  });

  it("asks rather than acts when the model is unsure", async () => {
    const site = await clinic("unsure");
    const conversation = await startConversation(site);

    ai.interpreter.push(envelope({ intent: "SEARCH_SLOTS", confidence: 0.2 }));
    const turn = await say(conversation, "mmm maybe something next week?");

    expect(turn.message.key).toBe("conversation.error.unclear");
  });

  it("says so when it cannot read a date rather than guessing one", async () => {
    const site = await clinic("vague");
    const conversation = await startConversation(site);

    ai.interpreter.push(
      envelope({
        intent: "SEARCH_SLOTS",
        parameters: { serviceQuery: "dental check-up", dateExpression: "sometime soonish" },
      }),
    );

    const turn = await say(conversation, "sometime soonish");
    expect(turn.message.key).toBe("conversation.error.date");
  });

  // -------------------------------------------------------------------------
  // The token
  // -------------------------------------------------------------------------

  it("gives one 404 for every way a token can fail", async () => {
    const site = await clinic("tokens");
    const conversation = await startConversation(site);

    const wrongToken = await app.inject({
      method: "GET",
      url: `/v1/public/conversations/${conversation.id}`,
      headers: { "x-conversation-token": randomBytes(32).toString("base64url") },
    });

    const unknownId = await app.inject({
      method: "GET",
      url: `/v1/public/conversations/cnv000000000000000000000`,
      headers: conversation.headers,
    });

    for (const response of [wrongToken, unknownId]) {
      expect(response.statusCode).toBe(404);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        "CONVERSATION_NOT_FOUND",
      );
    }
  });

  it("does not let one tenant's token open another tenant's conversation", async () => {
    const first = await clinic("tenanta");
    const second = await clinic("tenantb");

    const theirs = await startConversation(first);
    const ours = await startConversation(second);

    const crossed = await app.inject({
      method: "GET",
      url: `/v1/public/conversations/${theirs.id}`,
      headers: ours.headers,
    });

    expect(crossed.statusCode).toBe(404);
  });

  it("survives a page refresh", async () => {
    const site = await clinic("refresh");
    const { conversation, prepared } = await upToConfirmation(site);

    const replayed = await app.inject({
      method: "GET",
      url: `/v1/public/conversations/${conversation.id}`,
      headers: conversation.headers,
    });

    expect(replayed.statusCode, replayed.body).toBe(200);
    const body = replayed.json<TurnBody>();

    expect(body.state).toBe("AWAITING_CONFIRMATION");
    // The card is still confirmable — the customer refreshed, they did not
    // change their mind.
    expect(body.confirmation?.actionId).toBe(prepared.confirmation?.actionId);
    expect(body.messages).toBeDefined();
    expect(body.messages?.some((message) => message.content === "the first one")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Metering
  // -------------------------------------------------------------------------

  it("meters every model call against the tenant that caused it", async () => {
    const site = await clinic("metered");
    const conversation = await startConversation(site);

    ai.interpreter.push(envelope({ intent: "LIST_SERVICES" }), { input: 900, output: 40 });
    await say(conversation, "what do you offer?");

    const aggregates = await app.prisma.usageAggregate.findMany({
      where: { tenantId: site.tenantId },
      orderBy: { category: "asc" },
    });

    const input = aggregates.find((row) => row.category === "AI_INPUT_TOKENS");
    const output = aggregates.find((row) => row.category === "AI_OUTPUT_TOKENS");

    expect(input?.quantity).toBe(900);
    expect(output?.quantity).toBe(40);
    // Cost is attributed to the input row only, so a total that sums the column
    // does not count it twice.
    expect(input?.estimatedCostMinor).toBeGreaterThan(0);
    expect(output?.estimatedCostMinor).toBe(0);
  });

  it("does not offer chat to the Form plan", async () => {
    const site = await clinic("overspent");
    await app.prisma.subscription.upsert({
      where: { tenantId: site.tenantId },
      create: { tenantId: site.tenantId, plan: "STARTER", status: "ACTIVE" },
      update: { plan: "STARTER", status: "ACTIVE" },
    });

    const availability = await app.inject({
      method: "GET",
      url: `/v1/public/tenants/${site.slug}/assistant`,
    });
    expect(availability.statusCode).toBe(200);
    expect(availability.json<{ available: boolean }>().available).toBe(false);

    const response = await app.inject({
      method: "POST",
      url: `/v1/public/tenants/${site.slug}/conversations`,
      payload: { channel: "CHAT", locale: "en", timezone: "UTC" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      "CONVERSATION_UNAVAILABLE",
    );

    const settings = await app.inject({
      method: "GET",
      url: "/v1/assistant/settings",
      headers: as(site.ownerCookie, site.tenantId),
    });
    expect(settings.statusCode).toBe(403);
  });

  it("stops an existing conversation after the tenant moves to Form", async () => {
    const site = await clinic("downgraded");
    const conversation = await startConversation(site);

    await app.prisma.subscription.update({
      where: { tenantId: site.tenantId },
      data: { plan: "STARTER", status: "ACTIVE" },
    });

    const replay = await app.inject({
      method: "GET",
      url: `/v1/public/conversations/${conversation.id}`,
      headers: conversation.headers,
    });
    expect(replay.statusCode).toBe(503);
    expect(replay.json<{ error: { code: string } }>().error.code).toBe("CONVERSATION_UNAVAILABLE");
  });

  it("stops AI Receptionist chat once its monthly allowance is gone", async () => {
    const site = await clinic("ai-overspent");
    await app.prisma.subscription.update({
      where: { tenantId: site.tenantId },
      data: { plan: "PROFESSIONAL", status: "ACTIVE" },
    });
    await app.prisma.usageAggregate.create({
      data: {
        tenantId: site.tenantId,
        period: `${new Date().getUTCFullYear()}-${`${new Date().getUTCMonth() + 1}`.padStart(2, "0")}`,
        category: "AI_INPUT_TOKENS",
        quantity: 2_000_000,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/public/tenants/${site.slug}/conversations`,
      payload: { channel: "CHAT", locale: "en", timezone: "UTC" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      "CONVERSATION_UNAVAILABLE",
    );
  });
});
