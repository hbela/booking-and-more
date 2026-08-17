import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleCalendarClient } from "./google.calendar.js";
import { buildBookingEvent, deriveEventId } from "./google.events.js";
import { classifyUnknown, GoogleFailureKinds } from "./google.errors.js";

/**
 * The Calendar API layer, against Google's real response shapes.
 *
 * The assertion that earns its keep is the 409: it is what turns the derived
 * event id into an idempotency mechanism, and the difference between a retried
 * job and a second appointment in somebody's diary.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: (response.status ?? 200) < 400,
        status: response.status ?? 200,
        json: () => Promise.resolve(response.body),
      } as Response);
    }),
  );

  return calls;
}

/**
 * The JSON this client sent.
 *
 * `BodyInit` is a union that includes streams and form data, so narrowing here
 * rather than stringifying keeps the assertion honest: if the client ever stops
 * sending a JSON string, these tests fail loudly instead of comparing against
 * "[object Object]".
 */
function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("expected a JSON string body");
  return JSON.parse(body) as Record<string, unknown>;
}

const booking = {
  bookingId: "bkg_1",
  reference: "BK-4C7A",
  serviceName: "Fogtisztítás",
  customerName: "Nagy Béla",
  customerPhone: null,
  notes: null,
  locationName: null,
  locationAddress: null,
  startAt: new Date("2026-09-07T08:00:00.000Z"),
  endAt: new Date("2026-09-07T08:30:00.000Z"),
  timezone: "Europe/Budapest",
  manageUrl: null,
};

const CALENDAR_ID = "anna@example.test";
const EVENT_ID = deriveEventId("bkg_1", "map_1");

describe("listCalendars", () => {
  it("asks only for calendars the account can write to", async () => {
    // A reader-role calendar cannot receive an event, and offering one on the
    // selection screen produces a 403 the provider cannot act on.
    const calls = stubFetch({
      body: {
        items: [
          { id: "anna@example.test", summary: "Anna", primary: true, accessRole: "owner", timeZone: "Europe/Budapest" },
          { id: "team@group.calendar.google.com", summary: "Team", accessRole: "writer" },
        ],
      },
    });

    const calendars = await createGoogleCalendarClient().listCalendars("ya29.x");

    expect(calls[0]?.url).toContain("minAccessRole=writer");
    expect(calendars).toHaveLength(2);
    expect(calendars[0]).toMatchObject({ id: "anna@example.test", primary: true });
    expect(calendars[1]?.timeZone).toBeNull();
  });

  it("survives an empty account", async () => {
    stubFetch({ body: {} });

    await expect(createGoogleCalendarClient().listCalendars("ya29.x")).resolves.toEqual([]);
  });

  it("drops an entry with no id rather than sending undefined to Google later", async () => {
    stubFetch({ body: { items: [{ summary: "Broken" }, { id: "ok@example.test" }] } });

    const calendars = await createGoogleCalendarClient().listCalendars("ya29.x");

    expect(calendars.map((entry) => entry.id)).toEqual(["ok@example.test"]);
  });
});

describe("insertEvent", () => {
  it("supplies our own id and suppresses Google's own emails", async () => {
    const calls = stubFetch({ body: { id: EVENT_ID, etag: '"abc123"', status: "confirmed" } });

    const result = await createGoogleCalendarClient().insertEvent({
      accessToken: "ya29.x",
      calendarId: CALENDAR_ID,
      eventId: EVENT_ID,
      event: buildBookingEvent(booking),
    });

    expect(result).toEqual({ id: EVENT_ID, etag: '"abc123"', status: "confirmed" });

    const body = bodyOf(calls[0]?.init);
    expect(body["id"]).toBe(EVENT_ID);
    // There are no attendees today, so Google would not email anybody — but the
    // day somebody adds one, this is what stops silent mail to a real customer.
    expect(calls[0]?.url).toContain("sendUpdates=none");
  });

  it("reports a duplicate as already-existing, not as a failure", async () => {
    // **The idempotency proof.** A retry landing after the first insert
    // committed is refused by Google rather than creating a second appointment,
    // and the caller treats that refusal as success.
    stubFetch({
      status: 409,
      body: { error: { errors: [{ reason: "duplicate" }], message: "The requested identifier already exists." } },
    });

    const failure = await createGoogleCalendarClient()
      .insertEvent({
        accessToken: "ya29.x",
        calendarId: CALENDAR_ID,
        eventId: EVENT_ID,
        event: buildBookingEvent(booking),
      })
      .catch((error: unknown) => classifyUnknown(error));

    expect(failure).toMatchObject({ kind: GoogleFailureKinds.ALREADY_EXISTS });
  });

  it("escapes a calendar id that contains a slash", async () => {
    // Calendar ids are often email addresses and occasionally worse. An
    // unescaped one silently addresses a different URL path.
    const calls = stubFetch({ body: { id: EVENT_ID } });

    await createGoogleCalendarClient().insertEvent({
      accessToken: "ya29.x",
      calendarId: "weird/id@group.calendar.google.com",
      eventId: EVENT_ID,
      event: buildBookingEvent(booking),
    });

    expect(calls[0]?.url).toContain("weird%2Fid%40group.calendar.google.com");
  });

  it("classifies a rate limit as retryable and a permission error as not", async () => {
    for (const [reason, expected] of [
      ["rateLimitExceeded", GoogleFailureKinds.RETRY],
      ["insufficientPermissions", GoogleFailureKinds.RECONNECT],
    ] as const) {
      stubFetch({ status: 403, body: { error: { errors: [{ reason }] } } });

      const failure = await createGoogleCalendarClient()
        .insertEvent({
          accessToken: "ya29.x",
          calendarId: CALENDAR_ID,
          eventId: EVENT_ID,
          event: buildBookingEvent(booking),
        })
        .catch((error: unknown) => classifyUnknown(error));

      expect(failure).toMatchObject({ kind: expected });
    }
  });
});

describe("patchEvent and cancelEvent", () => {
  it("patches rather than replacing, and sends no If-Match", async () => {
    // We are the authority (PRD §9.10), so a stale etag must not refuse our
    // correction. The etag is recorded for part 2 and never used as a
    // precondition here.
    const calls = stubFetch({ body: { id: EVENT_ID, etag: '"v2"', status: "confirmed" } });

    await createGoogleCalendarClient().patchEvent({
      accessToken: "ya29.x",
      calendarId: CALENDAR_ID,
      eventId: EVENT_ID,
      event: buildBookingEvent({ ...booking, startAt: new Date("2026-09-07T09:00:00.000Z") }),
    });

    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.stringify(calls[0]?.init?.headers)).not.toContain("If-Match");
  });

  it("cancels by status rather than deleting", async () => {
    // §2.3: a deleted id is not immediately reusable, and the derived id has to
    // stay reserved for a booking that is cancelled and then reinstated.
    const calls = stubFetch({ body: { id: EVENT_ID, status: "cancelled" } });

    const result = await createGoogleCalendarClient().cancelEvent({
      accessToken: "ya29.x",
      calendarId: CALENDAR_ID,
      eventId: EVENT_ID,
    });

    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(bodyOf(calls[0]?.init)).toEqual({ status: "cancelled" });
    expect(result.status).toBe("cancelled");
  });

  it("asks to recreate an event somebody deleted in Google", async () => {
    stubFetch({ status: 410, body: { error: { errors: [{ reason: "deleted" }] } } });

    const failure = await createGoogleCalendarClient()
      .patchEvent({
        accessToken: "ya29.x",
        calendarId: CALENDAR_ID,
        eventId: EVENT_ID,
        event: {},
      })
      .catch((error: unknown) => classifyUnknown(error));

    expect(failure).toMatchObject({ kind: GoogleFailureKinds.RECREATE });
  });

  it("parks a calendar that no longer exists", async () => {
    // §26.3's "Invalid calendar ID": retrying cannot conjure one back.
    stubFetch({ status: 404, body: { error: { errors: [{ reason: "notFound" }] } } });

    const failure = await createGoogleCalendarClient()
      .getEvent({ accessToken: "ya29.x", calendarId: "gone@example.test", eventId: EVENT_ID })
      .catch((error: unknown) => classifyUnknown(error));

    expect(failure).toMatchObject({ kind: GoogleFailureKinds.PARK, reason: "notFound" });
  });
});

describe("getEvent", () => {
  it("recovers the etag after a duplicate", async () => {
    // The other half of the 409 path: Google has the event, we do not have its
    // etag, and one GET closes the gap without a second write.
    stubFetch({ body: { id: EVENT_ID, etag: '"recovered"', status: "confirmed" } });

    await expect(
      createGoogleCalendarClient().getEvent({
        accessToken: "ya29.x",
        calendarId: CALENDAR_ID,
        eventId: EVENT_ID,
      }),
    ).resolves.toMatchObject({ etag: '"recovered"' });
  });

  it("sends the access token as a bearer credential and nothing else", async () => {
    const calls = stubFetch({ body: { id: EVENT_ID } });

    await createGoogleCalendarClient().getEvent({
      accessToken: "ya29.secret",
      calendarId: CALENDAR_ID,
      eventId: EVENT_ID,
    });

    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer ya29.secret" });
    expect(calls[0]?.url).not.toContain("ya29.secret");
  });
});
