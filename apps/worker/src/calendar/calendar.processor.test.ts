import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseEncryptionKey, sealToken } from "@bam/crypto";
import { createPrismaClient, type PrismaClient } from "@bam/db";
import {
  deriveEventId,
  GoogleApiError,
  type GoogleCalendarClient,
  type GoogleEventResult,
  type GoogleOAuthClient,
  type GoogleTokenSet,
} from "@bam/google-calendar";
import { createLogger } from "@bam/observability";

import { CalendarOutcomes, syncCalendarEvent } from "./calendar.processor.js";
import { QueueNames, type QueueRegistry } from "../queues.js";

/**
 * The processor, against a real PostgreSQL and a fake Google.
 *
 * The database half is what matters here — claiming a row exactly once, and
 * recording the right terminal state under every failure — so it is real.
 * Google is faked because "does Google accept this body" is not a property of
 * our code, and the wire format is proved in `@bam/google-calendar`.
 *
 * ## The two assertions that justify the file
 *
 * **`booking.status` is still CONFIRMED after every failure path.** PRD §9.10
 * and tech-impl §25.6 promise a customer that a calendar problem is not a
 * booking problem, and a promise nothing asserts is a comment. It is checked at
 * the end of each failure test rather than once in a summary, because the value
 * of it is per-path.
 *
 * **A 409 duplicate still reaches SYNCED.** That is what makes the derived event
 * id an idempotency mechanism (§2.3) — the difference between a retried job and
 * a second appointment in somebody's diary.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];
const suffix = Math.random().toString(36).slice(2, 10);

const log = createLogger({ service: "calendar-test", level: "silent", pretty: false });

const ENCRYPTION_KEY = parseEncryptionKey("0".repeat(32) + "f".repeat(32));
const REFRESH_TOKEN = "1//0gRefreshToken";
const ACCESS_TOKEN = "ya29.a0AccessToken";

/** Google's Calendar API, under this suite's control. */
function stubCalendar() {
  const calls: { op: string; calendarId: string; eventId: string }[] = [];

  const next = {
    /** Queued failures, consumed one per call. Anything else succeeds. */
    insert: null as GoogleApiError | null,
    patch: null as GoogleApiError | null,
    cancel: null as GoogleApiError | null,
    etag: '"v1"',
  };

  function record(op: string, args: { calendarId: string; eventId: string }): GoogleEventResult {
    calls.push({ op, calendarId: args.calendarId, eventId: args.eventId });
    return { id: args.eventId, etag: next.etag, status: "confirmed" };
  }

  const client: GoogleCalendarClient = {
    listCalendars: () => Promise.reject(new Error("the processor never lists calendars")),
    insertEvent: (args) => {
      if (next.insert !== null) {
        const error = next.insert;
        next.insert = null;
        calls.push({ op: "insert:failed", calendarId: args.calendarId, eventId: args.eventId });
        return Promise.reject(error);
      }
      return Promise.resolve(record("insert", args));
    },
    patchEvent: (args) => {
      if (next.patch !== null) {
        const error = next.patch;
        next.patch = null;
        calls.push({ op: "patch:failed", calendarId: args.calendarId, eventId: args.eventId });
        return Promise.reject(error);
      }
      return Promise.resolve(record("patch", args));
    },
    cancelEvent: (args) => {
      if (next.cancel !== null) {
        const error = next.cancel;
        next.cancel = null;
        calls.push({ op: "cancel:failed", calendarId: args.calendarId, eventId: args.eventId });
        return Promise.reject(error);
      }
      return Promise.resolve({ ...record("cancel", args), status: "cancelled" });
    },
    getEvent: () => Promise.reject(new Error("the processor never reads events")),
  };

  return { client, next, calls, ops: () => calls.map((call) => call.op) };
}

function stubOAuth() {
  const refreshed: string[] = [];

  const next = {
    error: null as GoogleApiError | null,
    tokens: null as GoogleTokenSet | null,
  };

  const client: GoogleOAuthClient = {
    exchangeCode: () => Promise.reject(new Error("the processor never exchanges codes")),
    refresh: (token: string) => {
      refreshed.push(token);
      if (next.error !== null) return Promise.reject(next.error);

      return Promise.resolve(
        next.tokens ?? {
          accessToken: "ya29.refreshed",
          refreshToken: undefined,
          expiresAt: new Date(Date.now() + 3_600_000),
          scopes: [],
        },
      );
    },
    fetchAccountEmail: () => Promise.reject(new Error("the processor never asks who this is")),
    revoke: () => Promise.resolve(),
  };

  return { client, next, refreshed };
}

/** Where the disconnection email would go. */
function fakeQueues() {
  const jobs: { queue: string; data: { notificationId?: string } }[] = [];

  const registry = Object.fromEntries(
    Object.values(QueueNames).map((queue) => [
      queue,
      {
        add: (_name: string, data: unknown) => {
          jobs.push({ queue, data } as { queue: string; data: { notificationId?: string } });
          return Promise.resolve({ id: "job" });
        },
      },
    ]),
  ) as unknown as QueueRegistry;

  return { registry, jobs };
}

describe.skipIf(!databaseUrl)("calendar processor", () => {
  let prisma: PrismaClient;
  let calendar: ReturnType<typeof stubCalendar>;
  let oauth: ReturnType<typeof stubOAuth>;
  let queues: ReturnType<typeof fakeQueues>;

  beforeEach(() => {
    prisma ??= createPrismaClient({ databaseUrl: databaseUrl! });
    calendar = stubCalendar();
    oauth = stubOAuth();
    queues = fakeQueues();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  function options(overrides: { maxAttempts?: number } = {}) {
    return {
      prisma,
      calendar: calendar.client,
      oauth: oauth.client,
      encryptionKey: ENCRYPTION_KEY,
      logger: log,
      maxAttempts: overrides.maxAttempts ?? 8,
      appBaseUrl: "http://localhost:3000",
      queues: queues.registry,
      // Full jitter would otherwise make "did it back off" unassertable.
      random: () => 1,
    };
  }

  /**
   * A tenant with a connected calendar and one confirmed booking already queued.
   *
   * Built by inserting rows rather than through the API: the routes that produce
   * this state have their own suite, and what is under test here is what the
   * processor does with the state, not how it arose.
   */
  async function scenario(
    overrides: {
      integrationStatus?: "ACTIVE" | "NEEDS_RECONNECT" | "DISCONNECTED";
      mappingActive?: boolean;
      sealedRefreshToken?: string | null;
      accessTokenExpiresAt?: Date;
      desiredState?: "PRESENT" | "CANCELLED";
      syncedVersion?: number | null;
      attempts?: number;
      bookingVersion?: number;
    } = {},
  ) {
    const unique = `${suffix}-${Math.random().toString(36).slice(2, 8)}`;

    const tenant = await prisma.tenant.create({
      data: { slug: `cal-${unique}`, name: "Calendar Clinic", defaultLanguage: "hu" },
    });

    const user = await prisma.user.create({
      data: { email: `cal-${unique}@example.test`, name: "Kovács Anna", emailVerified: true },
    });

    // The consenting user is a member of the organization, which is the
    // ordinary state and the one the disconnection email's recipient rule tests.
    await prisma.membership.create({
      data: { tenantId: tenant.id, userId: user.id, role: "PROVIDER", status: "ACTIVE" },
    });

    const provider = await prisma.provider.create({
      data: {
        tenantId: tenant.id,
        displayName: "Dr. Kovács Anna",
        email: `provider-${unique}@example.test`,
        timezone: "Europe/Budapest",
      },
    });

    const service = await prisma.service.create({
      data: {
        tenantId: tenant.id,
        name: "Fogtisztítás",
        slug: `clean-${unique}`,
        durationMinutes: 30,
      },
    });

    const customer = await prisma.customer.create({
      data: { tenantId: tenant.id, fullName: "Nagy Béla", phone: "+36301234567" },
    });

    const integration = await prisma.calendarIntegration.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        providerId: provider.id,
        accountEmail: `anna-${unique}@gmail.com`,
        sealedAccessToken: sealToken(ACCESS_TOKEN, ENCRYPTION_KEY),
        sealedRefreshToken:
          overrides.sealedRefreshToken === null
            ? null
            : sealToken(overrides.sealedRefreshToken ?? REFRESH_TOKEN, ENCRYPTION_KEY),
        accessTokenExpiresAt: overrides.accessTokenExpiresAt ?? new Date(Date.now() + 3_600_000),
        scopes: ["https://www.googleapis.com/auth/calendar.events"],
        status: overrides.integrationStatus ?? "ACTIVE",
      },
    });

    const mapping = await prisma.calendarMapping.create({
      data: {
        tenantId: tenant.id,
        calendarIntegrationId: integration.id,
        providerId: provider.id,
        externalCalendarId: `anna-${unique}@gmail.com`,
        calendarName: "Anna",
        active: overrides.mappingActive ?? true,
      },
    });

    const startAt = new Date(Date.now() + 48 * 3_600_000);
    const booking = await prisma.booking.create({
      data: {
        tenantId: tenant.id,
        reference: `BK-${unique.slice(0, 6)}`,
        customerId: customer.id,
        providerId: provider.id,
        serviceId: service.id,
        startAt,
        endAt: new Date(startAt.getTime() + 30 * 60_000),
        status: "CONFIRMED",
        version: overrides.bookingVersion ?? 1,
        customerNameSnapshot: "Nagy Béla",
        customerPhoneSnapshot: "+36301234567",
        serviceNameSnapshot: "Fogtisztítás",
      },
    });

    const row = await prisma.calendarEventMapping.create({
      data: {
        tenantId: tenant.id,
        bookingId: booking.id,
        calendarMappingId: mapping.id,
        externalEventId: deriveEventId(booking.id, mapping.id),
        desiredState: overrides.desiredState ?? "PRESENT",
        desiredVersion: overrides.bookingVersion ?? 1,
        syncedVersion: overrides.syncedVersion ?? null,
        attempts: overrides.attempts ?? 0,
        syncStatus: "PENDING",
      },
    });

    return { tenantId: tenant.id, user, integration, mapping, booking, row };
  }

  /** §25.6, asserted per path rather than once. */
  async function expectBookingUntouched(bookingId: string): Promise<void> {
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(
      booking.status,
      "a calendar failure must never change a booking (PRD §9.10)",
    ).toBe("CONFIRMED");
  }

  // -------------------------------------------------------------------------
  // The happy paths
  // -------------------------------------------------------------------------

  it("creates the event with our own derived id", async () => {
    const { tenantId, row, mapping, booking } = await scenario();

    const outcome = await syncCalendarEvent(
      { tenantId, eventMappingId: row.id },
      options(),
    );

    expect(outcome).toBe(CalendarOutcomes.SYNCED);
    expect(calendar.calls).toEqual([
      {
        op: "insert",
        calendarId: mapping.externalCalendarId,
        eventId: deriveEventId(booking.id, mapping.id),
      },
    ]);

    const after = await prisma.calendarEventMapping.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({
      syncStatus: "SYNCED",
      syncedVersion: 1,
      externalEventEtag: '"v1"',
      claimedAt: null,
      lastError: null,
      attempts: 0,
    });
    expect(after.lastSyncedAt).not.toBeNull();
  });

  it("patches rather than inserting once Google already has it", async () => {
    // `syncedVersion` is what tells create from update, and it is read at the
    // moment the job runs — which is why there is one job name rather than three.
    const { tenantId, row } = await scenario({ syncedVersion: 1, bookingVersion: 2 });

    const outcome = await syncCalendarEvent({ tenantId, eventMappingId: row.id }, options());

    expect(outcome).toBe(CalendarOutcomes.SYNCED);
    expect(calendar.ops()).toEqual(["patch"]);

    const after = await prisma.calendarEventMapping.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.syncedVersion).toBe(2);
  });

  it("reaches SYNCED when Google refuses the insert as a duplicate", async () => {
    // **The idempotency proof.** A worker killed between Google's 200 and our
    // row update leaves an event with our id and a row that thinks it created
    // nothing — the case the unique index cannot cover (§2.3). The retry is
    // refused with a 409 and reconciles by patching, rather than putting a
    // second appointment in somebody's diary.
    const { tenantId, row, booking } = await scenario();
    calendar.next.insert = new GoogleApiError("duplicate", {
      status: 409,
      reason: "duplicate",
    });

    const outcome = await syncCalendarEvent({ tenantId, eventMappingId: row.id }, options());

    expect(outcome).toBe(CalendarOutcomes.SYNCED);
    expect(calendar.ops()).toEqual(["insert:failed", "patch"]);

    const after = await prisma.calendarEventMapping.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.syncStatus).toBe("SYNCED");
    await expectBookingUntouched(booking.id);
  });

  it("recreates an event somebody deleted in Google", async () => {
    // The database is authoritative (PRD §9.10), so a 410 on a patch means put
    // it back rather than accept the deletion. The id is still ours because we
    // cancel rather than delete.
    const { tenantId, row } = await scenario({ syncedVersion: 1, bookingVersion: 2 });
    calendar.next.patch = new GoogleApiError("gone", { status: 410, reason: "deleted" });

    const outcome = await syncCalendarEvent({ tenantId, eventMappingId: row.id }, options());

    expect(outcome).toBe(CalendarOutcomes.SYNCED);
    expect(calendar.ops()).toEqual(["patch:failed", "insert"]);
  });

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  it("greys the event out rather than deleting it", async () => {
    const { tenantId, row } = await scenario({
      desiredState: "CANCELLED",
      syncedVersion: 1,
      bookingVersion: 2,
    });

    const outcome = await syncCalendarEvent({ tenantId, eventMappingId: row.id }, options());

    expect(outcome).toBe(CalendarOutcomes.SYNCED);
    expect(calendar.ops()).toEqual(["cancel"]);
  });

  it("calls nothing to cancel an event that was never created", async () => {
    // A booking cancelled before its create job ran. Calling Google would earn a
    // 404 we would then have to classify as success.
    const { tenantId, row } = await scenario({ desiredState: "CANCELLED", syncedVersion: null });

    const outcome = await syncCalendarEvent({ tenantId, eventMappingId: row.id }, options());

    expect(outcome).toBe(CalendarOutcomes.SYNCED);
    expect(calendar.calls).toEqual([]);
  });

  it("treats an event already gone from Google as cancelled", async () => {
    const { tenantId, row } = await scenario({
      desiredState: "CANCELLED",
      syncedVersion: 1,
      bookingVersion: 2,
    });
    calendar.next.cancel = new GoogleApiError("gone", { status: 410, reason: "deleted" });

    const outcome = await syncCalendarEvent({ tenantId, eventMappingId: row.id }, options());

    expect(outcome).toBe(CalendarOutcomes.SYNCED);
  });

  // -------------------------------------------------------------------------
  // Claiming
  // -------------------------------------------------------------------------

  it("refuses a second worker, and a job that arrives before its backoff", async () => {
    const { tenantId, row } = await scenario();

    await prisma.calendarEventMapping.update({
      where: { id: row.id },
      data: { syncStatus: "SYNCING", claimedAt: new Date() },
    });
    await expect(
      syncCalendarEvent({ tenantId, eventMappingId: row.id }, options()),
    ).resolves.toBe(CalendarOutcomes.NOT_CLAIMED);

    // Pending, but not due. `nextAttemptAt` is in the claim predicate rather
    // than checked afterwards, so a premature job never takes the row at all.
    await prisma.calendarEventMapping.update({
      where: { id: row.id },
      data: { syncStatus: "PENDING", nextAttemptAt: new Date(Date.now() + 600_000) },
    });
    await expect(
      syncCalendarEvent({ tenantId, eventMappingId: row.id }, options()),
    ).resolves.toBe(CalendarOutcomes.NOT_CLAIMED);

    expect(calendar.calls).toEqual([]);
  });

  it("leaves the row pending when the booking changes mid-sync", async () => {
    // §2.4's guard. A reschedule that lands while we are talking to Google has
    // already bumped `desiredVersion`; writing SYNCED here would claim Google
    // holds a version it does not, and the row would stop looking like work.
    const { tenantId, row } = await scenario();

    const bumped = {
      ...options(),
      calendar: {
        ...calendar.client,
        insertEvent: async (args: Parameters<GoogleCalendarClient["insertEvent"]>[0]) => {
          await prisma.calendarEventMapping.update({
            where: { id: row.id },
            data: { desiredVersion: 5 },
          });
          return calendar.client.insertEvent(args);
        },
      },
    };

    const outcome = await syncCalendarEvent({ tenantId, eventMappingId: row.id }, bumped);

    expect(outcome).toBe(CalendarOutcomes.SUPERSEDED);

    const after = await prisma.calendarEventMapping.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.syncStatus).toBe("PENDING");
    expect(after.desiredVersion).toBe(5);
    // The etag is kept: it describes the event Google now holds, which the next
    // attempt will patch.
    expect(after.externalEventEtag).toBe('"v1"');
  });

  // -------------------------------------------------------------------------
  // Failure
  // -------------------------------------------------------------------------

  it("backs off a transient failure and keeps the booking confirmed", async () => {
    const { tenantId, row, booking } = await scenario();
    calendar.next.insert = new GoogleApiError("unavailable", { status: 503 });

    await expect(
      syncCalendarEvent({ tenantId, eventMappingId: row.id }, options()),
    ).rejects.toThrow(/calendar sync failed/u);

    const after = await prisma.calendarEventMapping.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.syncStatus).toBe("PENDING");
    expect(after.attempts).toBe(1);
    expect(after.claimedAt).toBeNull();
    expect(after.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 1_000);
    expect(after.lastError).toBe("http 503");

    await expectBookingUntouched(booking.id);
  });

  it("parks a row that has exhausted its attempts", async () => {
    const { tenantId, row, booking } = await scenario({ attempts: 7 });
    calendar.next.insert = new GoogleApiError("unavailable", { status: 503 });

    const outcome = await syncCalendarEvent(
      { tenantId, eventMappingId: row.id },
      options({ maxAttempts: 8 }),
    );

    expect(outcome).toBe(CalendarOutcomes.FAILED);

    const after = await prisma.calendarEventMapping.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.syncStatus).toBe("FAILED");
    expect(after.claimedAt).toBeNull();

    await expectBookingUntouched(booking.id);
  });

  it("parks a permanent failure at once, without spending the budget", async () => {
    // §26.3 forbids retrying a permanently-broken thing. An invalid calendar id
    // is not fixed by waiting, and the sweep deliberately never picks FAILED up.
    const { tenantId, row, booking } = await scenario();
    calendar.next.insert = new GoogleApiError("no such calendar", {
      status: 404,
      reason: "notFound",
    });

    const outcome = await syncCalendarEvent({ tenantId, eventMappingId: row.id }, options());

    expect(outcome).toBe(CalendarOutcomes.FAILED);

    const after = await prisma.calendarEventMapping.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ syncStatus: "FAILED", attempts: 1, lastError: "notFound" });

    await expectBookingUntouched(booking.id);
  });

  it("reports a revoked grant on the integration and does not burn the row", async () => {
    // `invalid_grant` arrives as a 400 from the token endpoint, which is why the
    // classifier reads the reason before the status. The row waits for a human
    // rather than spending its attempts against a wall — otherwise a provider
    // who reconnects finds everything already parked.
    const { tenantId, row, integration, booking } = await scenario({
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
    });
    oauth.next.error = new GoogleApiError("revoked", { status: 400, reason: "invalid_grant" });

    const outcome = await syncCalendarEvent({ tenantId, eventMappingId: row.id }, options());

    expect(outcome).toBe(CalendarOutcomes.SKIPPED);

    const after = await prisma.calendarIntegration.findUniqueOrThrow({
      where: { id: integration.id },
    });
    expect(after.status).toBe("NEEDS_RECONNECT");
    expect(after.lastError).toBe("invalid_grant");
    expect(after.sealedAccessToken).toBeNull();

    const event = await prisma.calendarEventMapping.findUniqueOrThrow({ where: { id: row.id } });
    expect(event.syncStatus).toBe("PENDING");
    // Claimed, attempted, and given back: an attempt that never reached Google
    // is not an attempt.
    expect(event.attempts).toBe(0);
    expect(event.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 60_000);

    await expectBookingUntouched(booking.id);
  });

  it("tells the person who granted the consent, once a day", async () => {
    // The whole point of the daily dedupe key: a dead grant fails *every* queued
    // row, so a key-less trigger would send one email per booking — which is how
    // a well-meant alert becomes the reason somebody filters our address.
    const first = await scenario({ accessTokenExpiresAt: new Date(Date.now() - 60_000) });
    oauth.next.error = new GoogleApiError("revoked", { status: 400, reason: "invalid_grant" });

    await syncCalendarEvent({ tenantId: first.tenantId, eventMappingId: first.row.id }, options());

    const notifications = await prisma.notification.findMany({
      where: { tenantId: first.tenantId, type: "CALENDAR_DISCONNECTED" },
    });

    expect(notifications).toHaveLength(1);
    // Addressed to whoever granted the consent, not to the owner: only they can
    // re-consent to their own Google account.
    expect(notifications[0]!.recipient).toBe(first.user.email);
    expect(notifications[0]!.payload).toMatchObject({
      accountEmail: first.integration.accountEmail,
      providerName: "Dr. Kovács Anna",
      reconnectUrl: "http://localhost:3000/dashboard/integrations",
    });

    // And a job to send it, on the notifications queue rather than the calendar
    // one — from here it is an ordinary notification.
    expect(queues.jobs.filter((job) => job.queue === QueueNames.NOTIFICATIONS)).toHaveLength(1);

    // A second failure on the same day must add nothing. Provoked by reviving
    // the integration and running the same row again, because the unique index
    // forbids a second row for this (booking, calendar) pair.
    await prisma.calendarIntegration.update({
      where: { id: first.integration.id },
      data: {
        status: "ACTIVE",
        sealedAccessToken: sealToken(ACCESS_TOKEN, ENCRYPTION_KEY),
        accessTokenExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.calendarEventMapping.update({
      where: { id: first.row.id },
      data: { syncStatus: "PENDING", nextAttemptAt: new Date() },
    });
    oauth.next.error = new GoogleApiError("revoked", { status: 400, reason: "invalid_grant" });

    await syncCalendarEvent({ tenantId: first.tenantId, eventMappingId: first.row.id }, options());

    await expect(
      prisma.notification.count({
        where: { tenantId: first.tenantId, type: "CALENDAR_DISCONNECTED" },
      }),
    ).resolves.toBe(1);
  });

  it("writes to the owner when whoever consented has left the organization", async () => {
    // **Not** "when the user row has gone" — `CalendarIntegration.userId` is NOT
    // NULL and cascades, so the user is always there and a `?? owner` on the
    // relation would be unreachable. What is reachable is a member removed or
    // suspended while their account lives on, and mailing a departed colleague
    // about a clinic's diary is useless and a small disclosure besides.
    const site = await scenario({ accessTokenExpiresAt: new Date(Date.now() - 60_000) });

    const owner = await prisma.user.create({
      data: {
        email: `owner-${suffix}-${Math.random().toString(36).slice(2, 6)}@example.test`,
        name: "Az Ügyvezető",
        emailVerified: true,
      },
    });
    await prisma.membership.create({
      data: { tenantId: site.tenantId, userId: owner.id, role: "OWNER", status: "ACTIVE" },
    });

    // The consenting user keeps their account and loses their standing.
    await prisma.membership.updateMany({
      where: { tenantId: site.tenantId, userId: site.user.id },
      data: { status: "SUSPENDED" },
    });

    oauth.next.error = new GoogleApiError("revoked", { status: 400, reason: "invalid_grant" });
    await syncCalendarEvent({ tenantId: site.tenantId, eventMappingId: site.row.id }, options());

    const notification = await prisma.notification.findFirstOrThrow({
      where: { tenantId: site.tenantId, type: "CALENDAR_DISCONNECTED" },
    });

    expect(notification.recipient).toBe(owner.email);
    expect(notification.recipient).not.toBe(site.user.email);
  });

  it("refreshes a stale access token and re-seals it", async () => {
    const { tenantId, row, integration } = await scenario({
      accessTokenExpiresAt: new Date(Date.now() - 60_000),
    });

    const outcome = await syncCalendarEvent({ tenantId, eventMappingId: row.id }, options());

    expect(outcome).toBe(CalendarOutcomes.SYNCED);
    // Opened before use, which is the other half of "sealed at rest".
    expect(oauth.refreshed).toEqual([REFRESH_TOKEN]);

    const after = await prisma.calendarIntegration.findUniqueOrThrow({
      where: { id: integration.id },
    });
    expect(after.sealedAccessToken).not.toContain("ya29.refreshed");
    expect(after.status).toBe("ACTIVE");
  });

  // -------------------------------------------------------------------------
  // Nothing to do
  // -------------------------------------------------------------------------

  it("parks a row whose calendar is no longer selected", async () => {
    // The provider re-pointed their diary, or disconnected. No amount of waiting
    // brings a deselected calendar back.
    const { tenantId, row } = await scenario({ mappingActive: false });

    const outcome = await syncCalendarEvent({ tenantId, eventMappingId: row.id }, options());

    expect(outcome).toBe(CalendarOutcomes.SKIPPED);
    expect(calendar.calls).toEqual([]);

    const after = await prisma.calendarEventMapping.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.syncStatus).toBe("FAILED");
    expect(after.lastError).toBe("calendar is no longer selected");
  });

  it("holds a row for a connection that is waiting on a human", async () => {
    const { tenantId, row } = await scenario({ integrationStatus: "NEEDS_RECONNECT" });

    const outcome = await syncCalendarEvent({ tenantId, eventMappingId: row.id }, options());

    expect(outcome).toBe(CalendarOutcomes.SKIPPED);
    expect(calendar.calls).toEqual([]);

    const after = await prisma.calendarEventMapping.findUniqueOrThrow({ where: { id: row.id } });
    // Pending, not parked: a reconnect should resume rather than restart, so the
    // row has to still look like work an hour from now.
    expect(after.syncStatus).toBe("PENDING");
    expect(after.attempts).toBe(0);
  });

  it("cannot be driven across a tenant boundary", async () => {
    // Rule 5, at the one place a job payload meets a row id.
    const mine = await scenario();
    const theirs = await scenario();

    const outcome = await syncCalendarEvent(
      { tenantId: theirs.tenantId, eventMappingId: mine.row.id },
      options(),
    );

    expect(outcome).toBe(CalendarOutcomes.NOT_CLAIMED);
    expect(calendar.calls).toEqual([]);

    const untouched = await prisma.calendarEventMapping.findUniqueOrThrow({
      where: { id: mine.row.id },
    });
    expect(untouched.syncStatus).toBe("PENDING");
    expect(untouched.attempts).toBe(0);
  });
});
