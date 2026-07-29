import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "@bam/config";
import { ErrorCodes } from "@bam/contracts";
import { buildApp, type AppInstance } from "./app.js";

/**
 * Epic 3 through real HTTP: schedules, exceptions, and the slot search built on
 * them.
 *
 * The arithmetic itself is proved in @bam/availability-engine, where it can be
 * property-tested without a database. What is proved here is everything the
 * engine cannot see: that the right rows are loaded, that the right tenant owns
 * them, and that a provider can edit their own diary and nobody else's.
 *
 * That last one is the first real exercise of the `:own` permissions. Epic 1
 * wrote them and tested them failing closed because `Membership.providerId` was
 * always null; Epic 2 populated it; this is where it finally matters.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];

/** Random and file-prefixed — see the note in catalogue.test.ts. */
const RUN = `av${randomBytes(4).toString("hex")}`;

/** A Monday far enough ahead to clear any default booking window. */
const MONDAY = "2026-09-07";

describe.skipIf(!databaseUrl)("availability", () => {
  let app: AppInstance;

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

    app = await buildApp({ env, logger: false, rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.prisma.tenant.deleteMany({ where: { slug: { endsWith: RUN } } });
    await app.prisma.user.deleteMany({ where: { email: { endsWith: `${RUN}@example.test` } } });
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function signUp(label: string): Promise<{ cookie: string; email: string; id: string }> {
    const email = `${label}-${RUN}@example.test`;

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: { email, password: "correct-horse-battery-staple", name: label },
    });

    expect(response.statusCode, `sign-up failed: ${response.body}`).toBeLessThan(400);

    const setCookie = response.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
    const cookie = cookies
      .map((entry) => entry.split(";")[0])
      .filter(Boolean)
      .join("; ");

    const user = await app.prisma.user.findUnique({ where: { email } });
    return { cookie, email, id: user!.id };
  }

  function as(cookie: string, tenantId?: string) {
    return { cookie, ...(tenantId === undefined ? {} : { "x-tenant-id": tenantId }) };
  }

  /**
   * A clinic with one provider, one service, one location, all assigned, and a
   * Monday morning schedule. The state every availability question starts from.
   */
  async function clinic(label: string) {
    const owner = await signUp(label);
    const slug = `${label}-${RUN}`;

    const tenantResponse = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: as(owner.cookie),
      payload: { name: label, slug },
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

    const providerId = await create("/v1/providers", { displayName: "Dr. Kovács Anna" });
    const serviceId = await create("/v1/services", {
      name: "Consultation",
      durationMinutes: 60,
    });
    const locationId = await create("/v1/locations", {
      name: "Main surgery",
      type: "PHYSICAL",
      addressLine1: "Váci út 1",
    });

    await app.inject({
      method: "PUT",
      url: `/v1/providers/${providerId}/services`,
      headers: as(owner.cookie, tenantId),
      payload: { services: [{ serviceId }] },
    });
    await app.inject({
      method: "PUT",
      url: `/v1/providers/${providerId}/locations`,
      headers: as(owner.cookie, tenantId),
      payload: { locations: [{ locationId }] },
    });

    return { ...owner, slug, tenantId, providerId, serviceId, locationId };
  }

  async function setHours(
    site: { cookie: string; tenantId: string; providerId: string },
    workingHours: Record<string, unknown>[],
  ) {
    return app.inject({
      method: "PUT",
      url: `/v1/providers/${site.providerId}/working-hours`,
      headers: as(site.cookie, site.tenantId),
      payload: { workingHours },
    });
  }

  const MONDAY_MORNING = [{ weekday: 1, startTime: "09:00", endTime: "12:00" }];

  async function searchSlots(
    site: { cookie: string; tenantId: string; serviceId: string },
    overrides: Record<string, unknown> = {},
  ) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/slots/search",
      headers: as(site.cookie, site.tenantId),
      payload: {
        serviceId: site.serviceId,
        dateFrom: MONDAY,
        dateTo: MONDAY,
        ...overrides,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    return response.json().items as { startAt: string; providerId: string }[];
  }

  /** Slot starts as Budapest wall-clock, which is how a diary reads. */
  function localStarts(slots: { startAt: string }[]): string[] {
    return slots.map((slot) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Budapest",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(slot.startAt)),
    );
  }

  /**
   * Every start on the server's 15-minute grid, inclusive.
   *
   * The grid is deliberately finer than the service duration: a 60-minute
   * appointment offered every 15 minutes fills a diary far better than one
   * offered on the hour (see DEFAULT_SLOT_INTERVAL_MINUTES).
   */
  function everyQuarter(first: string, last: string): string[] {
    const toMinutes = (time: string): number => {
      const [hour, minute] = time.split(":").map(Number);
      return (hour ?? 0) * 60 + (minute ?? 0);
    };

    const starts: string[] = [];
    for (let at = toMinutes(first); at <= toMinutes(last); at += 15) {
      starts.push(
        `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`,
      );
    }
    return starts;
  }

  // -------------------------------------------------------------------------
  // Working hours
  // -------------------------------------------------------------------------

  describe("working hours", () => {
    it("stores and returns a week", async () => {
      const site = await clinic("hours");

      const saved = await setHours(site, [
        { weekday: 1, startTime: "09:00", endTime: "12:00" },
        { weekday: 1, startTime: "13:00", endTime: "17:00" },
        { weekday: 3, startTime: "10:00", endTime: "14:00" },
      ]);

      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().items).toHaveLength(3);

      const read = await app.inject({
        method: "GET",
        url: `/v1/providers/${site.providerId}/working-hours`,
        headers: as(site.cookie, site.tenantId),
      });

      const items = read.json().items as { weekday: number; startTime: string }[];
      // Ordered by weekday then start — the order a week is read in.
      expect(items.map((item) => `${String(item.weekday)} ${item.startTime}`)).toEqual([
        "1 09:00",
        "1 13:00",
        "3 10:00",
      ]);
    });

    it("replaces the whole week rather than appending", async () => {
      const site = await clinic("hours-replace");

      await setHours(site, MONDAY_MORNING);
      const second = await setHours(site, [{ weekday: 2, startTime: "14:00", endTime: "18:00" }]);

      const items = second.json().items as { weekday: number }[];
      expect(items).toHaveLength(1);
      expect(items[0]!.weekday).toBe(2);
    });

    it("accepts an empty week, which clears the schedule", async () => {
      const site = await clinic("hours-clear");

      await setHours(site, MONDAY_MORNING);
      const cleared = await setHours(site, []);

      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().items).toEqual([]);
      expect(await searchSlots(site)).toEqual([]);
    });

    it("accepts a period running to midnight", async () => {
      const site = await clinic("hours-midnight");
      const response = await setHours(site, [{ weekday: 1, startTime: "22:00", endTime: "24:00" }]);

      expect(response.statusCode, response.body).toBe(200);
    });

    it("rejects a malformed or empty period", async () => {
      const site = await clinic("hours-invalid");

      const malformed = await setHours(site, [{ weekday: 1, startTime: "9:00", endTime: "17:00" }]);
      expect(malformed.statusCode).toBe(422);

      const zeroLength = await setHours(site, [
        { weekday: 1, startTime: "09:00", endTime: "09:00" },
      ]);
      expect(zeroLength.statusCode).toBe(422);

      const badWeekday = await setHours(site, [
        { weekday: 8, startTime: "09:00", endTime: "17:00" },
      ]);
      expect(badWeekday.statusCode).toBe(422);
    });

    it("refuses a location from another tenant", async () => {
      const mine = await clinic("hours-iso-mine");
      const theirs = await clinic("hours-iso-theirs");

      const response = await setHours(mine, [
        { weekday: 1, startTime: "09:00", endTime: "17:00", locationId: theirs.locationId },
      ]);

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe(ErrorCodes.LOCATION_NOT_FOUND);
    });

    it("refuses to touch another tenant's provider", async () => {
      const mine = await clinic("hours-provider-mine");
      const theirs = await clinic("hours-provider-theirs");

      const response = await app.inject({
        method: "PUT",
        url: `/v1/providers/${theirs.providerId}/working-hours`,
        headers: as(mine.cookie, mine.tenantId),
        payload: { workingHours: MONDAY_MORNING },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe(ErrorCodes.PROVIDER_NOT_FOUND);
    });
  });

  // -------------------------------------------------------------------------
  // Exceptions
  // -------------------------------------------------------------------------

  describe("exceptions", () => {
    async function createException(
      site: { cookie: string; tenantId: string; providerId: string },
      payload: Record<string, unknown>,
    ) {
      return app.inject({
        method: "POST",
        url: `/v1/providers/${site.providerId}/availability-exceptions`,
        headers: as(site.cookie, site.tenantId),
        payload,
      });
    }

    it("blocks out time and removes the matching slots", async () => {
      const site = await clinic("exception-block");
      await setHours(site, MONDAY_MORNING);

      expect(localStarts(await searchSlots(site))).toEqual(everyQuarter("09:00", "11:00"));

      const created = await createException(site, {
        type: "UNAVAILABLE",
        startAt: `${MONDAY}T08:00:00Z`, // 10:00 local
        endAt: `${MONDAY}T09:00:00Z`, // 11:00 local
        reason: "Dentist appointment",
      });

      expect(created.statusCode, created.body).toBe(201);
      // Only two survive: an appointment must fit whole, so 09:15 (which would
      // run to 10:15) is gone along with the blocked hour itself.
      expect(localStarts(await searchSlots(site))).toEqual(["09:00", "11:00"]);
    });

    it("opens extra time outside the recurring hours", async () => {
      const site = await clinic("exception-extra");
      await setHours(site, MONDAY_MORNING);

      await createException(site, {
        type: "ADDITIONAL_AVAILABILITY",
        startAt: `${MONDAY}T15:00:00Z`, // 17:00 local
        endAt: `${MONDAY}T17:00:00Z`, // 19:00 local
      });

      expect(localStarts(await searchSlots(site))).toEqual([
        ...everyQuarter("09:00", "11:00"),
        ...everyQuarter("17:00", "18:00"),
      ]);
    });

    it("applies an exception scoped to one service only to that service", async () => {
      const site = await clinic("exception-scoped");
      await setHours(site, MONDAY_MORNING);

      const otherServiceResponse = await app.inject({
        method: "POST",
        url: "/v1/services",
        headers: as(site.cookie, site.tenantId),
        payload: { name: "Second opinion", durationMinutes: 60 },
      });
      const otherServiceId = otherServiceResponse.json().id as string;

      await app.inject({
        method: "PUT",
        url: `/v1/providers/${site.providerId}/services`,
        headers: as(site.cookie, site.tenantId),
        payload: { services: [{ serviceId: site.serviceId }, { serviceId: otherServiceId }] },
      });

      await createException(site, {
        type: "UNAVAILABLE",
        startAt: `${MONDAY}T07:00:00Z`,
        endAt: `${MONDAY}T10:00:00Z`,
        serviceId: site.serviceId,
      });

      // Blocked for the named service…
      expect(localStarts(await searchSlots(site))).toEqual([]);
      // …and untouched for the other.
      expect(localStarts(await searchSlots(site, { serviceId: otherServiceId }))).toEqual(
        everyQuarter("09:00", "11:00"),
      );
    });

    it("lists, updates and deletes", async () => {
      const site = await clinic("exception-crud");
      await setHours(site, MONDAY_MORNING);

      const created = await createException(site, {
        type: "UNAVAILABLE",
        startAt: `${MONDAY}T08:00:00Z`,
        endAt: `${MONDAY}T09:00:00Z`,
      });
      const exceptionId = created.json().id as string;

      const listed = await app.inject({
        method: "GET",
        url: `/v1/providers/${site.providerId}/availability-exceptions?from=${MONDAY}&to=${MONDAY}`,
        headers: as(site.cookie, site.tenantId),
      });
      expect(listed.json().items).toHaveLength(1);

      const patched = await app.inject({
        method: "PATCH",
        url: `/v1/availability-exceptions/${exceptionId}`,
        headers: as(site.cookie, site.tenantId),
        payload: { endAt: `${MONDAY}T10:00:00Z` },
      });
      expect(patched.statusCode, patched.body).toBe(200);
      // The 11:00 slot is now blocked too.
      expect(localStarts(await searchSlots(site))).toEqual(["09:00"]);

      const deleted = await app.inject({
        method: "DELETE",
        url: `/v1/availability-exceptions/${exceptionId}`,
        headers: as(site.cookie, site.tenantId),
      });
      expect(deleted.statusCode).toBe(204);
      expect(localStarts(await searchSlots(site))).toEqual(everyQuarter("09:00", "11:00"));
    });

    it("refuses an interval that ends before it starts, on create and on patch", async () => {
      const site = await clinic("exception-range");

      const backwards = await createException(site, {
        type: "UNAVAILABLE",
        startAt: `${MONDAY}T10:00:00Z`,
        endAt: `${MONDAY}T09:00:00Z`,
      });
      expect(backwards.statusCode).toBe(422);

      const created = await createException(site, {
        type: "UNAVAILABLE",
        startAt: `${MONDAY}T08:00:00Z`,
        endAt: `${MONDAY}T09:00:00Z`,
      });
      const exceptionId = created.json().id as string;

      // A patch moving only one end has to be checked against the stored other.
      const patched = await app.inject({
        method: "PATCH",
        url: `/v1/availability-exceptions/${exceptionId}`,
        headers: as(site.cookie, site.tenantId),
        payload: { endAt: `${MONDAY}T07:00:00Z` },
      });
      expect(patched.statusCode).toBe(422);
    });

    it("hides another tenant's exception behind a 404", async () => {
      const theirs = await clinic("exception-iso-theirs");
      const mine = await clinic("exception-iso-mine");

      const created = await createException(theirs, {
        type: "UNAVAILABLE",
        startAt: `${MONDAY}T08:00:00Z`,
        endAt: `${MONDAY}T09:00:00Z`,
      });
      const exceptionId = created.json().id as string;

      for (const method of ["PATCH", "DELETE"] as const) {
        const response = await app.inject({
          method,
          url: `/v1/availability-exceptions/${exceptionId}`,
          headers: as(mine.cookie, mine.tenantId),
          ...(method === "PATCH" ? { payload: { reason: "hijacked" } } : {}),
        });

        expect(response.statusCode, method).toBe(404);
      }

      // And it is untouched.
      const row = await app.prisma.availabilityException.findUnique({ where: { id: exceptionId } });
      expect(row?.reason).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // The `:own` permissions, exercised for the first time
  // -------------------------------------------------------------------------

  describe("provider self-service", () => {
    /** A clinic plus a PROVIDER member linked to a provider record. */
    async function withLinkedProvider(label: string) {
      const site = await clinic(label);
      const member = await signUp(`${label}-provider`);

      const invited = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(site.cookie, site.tenantId),
        payload: { email: member.email, role: "PROVIDER" },
      });
      const token = (invited.json().acceptUrl as string).split("/").pop()!;

      await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(member.cookie),
        payload: { token },
      });

      const membership = await app.prisma.membership.findFirst({
        where: { tenantId: site.tenantId, userId: member.id },
      });

      const linked = await app.inject({
        method: "PATCH",
        url: `/v1/members/${membership!.id}`,
        headers: as(site.cookie, site.tenantId),
        payload: { providerId: site.providerId },
      });
      expect(linked.statusCode, linked.body).toBe(200);

      return { site, member };
    }

    it("lets a provider set their own working hours", async () => {
      const { site, member } = await withLinkedProvider("own-hours");

      const response = await app.inject({
        method: "PUT",
        url: `/v1/providers/${site.providerId}/working-hours`,
        headers: as(member.cookie, site.tenantId),
        payload: { workingHours: MONDAY_MORNING },
      });

      expect(response.statusCode, response.body).toBe(200);
    });

    it("refuses a provider editing somebody else's diary", async () => {
      const { site, member } = await withLinkedProvider("own-other");

      const otherProvider = await app.inject({
        method: "POST",
        url: "/v1/providers",
        headers: as(site.cookie, site.tenantId),
        payload: { displayName: "Dr. Nagy Béla" },
      });
      const otherProviderId = otherProvider.json().id as string;

      const response = await app.inject({
        method: "PUT",
        url: `/v1/providers/${otherProviderId}/working-hours`,
        headers: as(member.cookie, site.tenantId),
        payload: { workingHours: MONDAY_MORNING },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe(ErrorCodes.FORBIDDEN);
    });

    it("refuses a provider whose membership is not linked to anything", async () => {
      // The Epic 1 guarantee, now with a real provider to fail against: an
      // unpopulated providerId must not act as a wildcard.
      const site = await clinic("own-unlinked");
      const member = await signUp("own-unlinked-provider");

      const invited = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(site.cookie, site.tenantId),
        payload: { email: member.email, role: "PROVIDER" },
      });
      const token = (invited.json().acceptUrl as string).split("/").pop()!;
      await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(member.cookie),
        payload: { token },
      });

      const response = await app.inject({
        method: "PUT",
        url: `/v1/providers/${site.providerId}/working-hours`,
        headers: as(member.cookie, site.tenantId),
        payload: { workingHours: MONDAY_MORNING },
      });

      expect(response.statusCode).toBe(403);
    });

    it("lets a provider block out their own time but not another's", async () => {
      const { site, member } = await withLinkedProvider("own-exception");

      const mine = await app.inject({
        method: "POST",
        url: `/v1/providers/${site.providerId}/availability-exceptions`,
        headers: as(member.cookie, site.tenantId),
        payload: {
          type: "UNAVAILABLE",
          startAt: `${MONDAY}T08:00:00Z`,
          endAt: `${MONDAY}T09:00:00Z`,
        },
      });
      expect(mine.statusCode, mine.body).toBe(201);

      const otherProvider = await app.inject({
        method: "POST",
        url: "/v1/providers",
        headers: as(site.cookie, site.tenantId),
        payload: { displayName: "Someone Else" },
      });

      const theirs = await app.inject({
        method: "POST",
        url: `/v1/providers/${otherProvider.json().id as string}/availability-exceptions`,
        headers: as(member.cookie, site.tenantId),
        payload: {
          type: "UNAVAILABLE",
          startAt: `${MONDAY}T08:00:00Z`,
          endAt: `${MONDAY}T09:00:00Z`,
        },
      });
      expect(theirs.statusCode).toBe(403);
    });

    it("lets an assistant read a schedule but not change it", async () => {
      const site = await clinic("assistant-hours");
      await setHours(site, MONDAY_MORNING);

      const member = await signUp("assistant-hours-member");
      const invited = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(site.cookie, site.tenantId),
        payload: { email: member.email, role: "ASSISTANT" },
      });
      const token = (invited.json().acceptUrl as string).split("/").pop()!;
      await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(member.cookie),
        payload: { token },
      });

      const read = await app.inject({
        method: "GET",
        url: `/v1/providers/${site.providerId}/working-hours`,
        headers: as(member.cookie, site.tenantId),
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().items).toHaveLength(1);

      const write = await app.inject({
        method: "PUT",
        url: `/v1/providers/${site.providerId}/working-hours`,
        headers: as(member.cookie, site.tenantId),
        payload: { workingHours: [] },
      });
      expect(write.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Slot search
  // -------------------------------------------------------------------------

  describe("slot search", () => {
    it("returns slots for a configured provider", async () => {
      const site = await clinic("slots-basic");
      await setHours(site, MONDAY_MORNING);

      const slots = await searchSlots(site);

      expect(localStarts(slots)).toEqual(everyQuarter("09:00", "11:00"));
      expect(slots.every((slot) => slot.providerId === site.providerId)).toBe(true);
    });

    it("returns nothing when the provider has no hours", async () => {
      const site = await clinic("slots-no-hours");
      expect(await searchSlots(site)).toEqual([]);
    });

    it("merges providers into one chronological list", async () => {
      const site = await clinic("slots-two");

      const second = await app.inject({
        method: "POST",
        url: "/v1/providers",
        headers: as(site.cookie, site.tenantId),
        payload: { displayName: "Dr. Nagy Béla" },
      });
      const secondId = second.json().id as string;

      await app.inject({
        method: "PUT",
        url: `/v1/providers/${secondId}/services`,
        headers: as(site.cookie, site.tenantId),
        payload: { services: [{ serviceId: site.serviceId }] },
      });

      await setHours(site, MONDAY_MORNING);
      await app.inject({
        method: "PUT",
        url: `/v1/providers/${secondId}/working-hours`,
        headers: as(site.cookie, site.tenantId),
        payload: { workingHours: [{ weekday: 1, startTime: "10:00", endTime: "12:00" }] },
      });

      const slots = await searchSlots(site);

      // Both providers in one list, ordered by time. The second only starts at
      // 10:00, so the earlier slots are the first provider's alone.
      expect(localStarts(slots)).toEqual(
        [...everyQuarter("09:00", "11:00"), ...everyQuarter("10:00", "11:00")].sort(),
      );
      expect(new Set(slots.map((slot) => slot.providerId)).size).toBe(2);

      // And narrowing to one provider returns only theirs.
      const narrowed = await searchSlots(site, { providerId: secondId });
      expect(narrowed.every((slot) => slot.providerId === secondId)).toBe(true);
    });

    it("takes the per-provider duration override into account", async () => {
      const site = await clinic("slots-override");
      await setHours(site, MONDAY_MORNING);

      await app.inject({
        method: "PUT",
        url: `/v1/providers/${site.providerId}/services`,
        headers: as(site.cookie, site.tenantId),
        payload: {
          services: [{ serviceId: site.serviceId, customDurationMinutes: 180 }],
        },
      });

      // Three hours fits the 09:00–12:00 morning exactly once.
      expect(localStarts(await searchSlots(site))).toEqual(["09:00"]);
    });

    it("applies the most restrictive booking window", async () => {
      const site = await clinic("slots-window");
      await setHours(site, MONDAY_MORNING);

      // The service allows two days' notice, the provider ten. Ten wins, and
      // the Monday is well inside it — so this only bites when the horizon is
      // shorter than the search.
      await app.inject({
        method: "PATCH",
        url: `/v1/services/${site.serviceId}`,
        headers: as(site.cookie, site.tenantId),
        payload: { maximumAdvanceDays: 365 },
      });
      await app.inject({
        method: "PATCH",
        url: `/v1/providers/${site.providerId}`,
        headers: as(site.cookie, site.tenantId),
        payload: { maximumAdvanceDays: 1 },
      });

      expect(await searchSlots(site)).toEqual([]);
    });

    it("refuses a service from another tenant", async () => {
      const mine = await clinic("slots-iso-mine");
      const theirs = await clinic("slots-iso-theirs");

      const response = await app.inject({
        method: "POST",
        url: "/v1/slots/search",
        headers: as(mine.cookie, mine.tenantId),
        payload: { serviceId: theirs.serviceId, dateFrom: MONDAY, dateTo: MONDAY },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe(ErrorCodes.SERVICE_NOT_FOUND);
    });

    it("refuses a range longer than two months", async () => {
      const site = await clinic("slots-range");

      const response = await app.inject({
        method: "POST",
        url: "/v1/slots/search",
        headers: as(site.cookie, site.tenantId),
        payload: { serviceId: site.serviceId, dateFrom: "2026-01-01", dateTo: "2026-12-31" },
      });

      expect(response.statusCode).toBe(422);
    });
  });

  // -------------------------------------------------------------------------
  // Public slot search
  // -------------------------------------------------------------------------

  describe("public slot search", () => {
    async function publicSearch(slug: string, payload: Record<string, unknown>) {
      return app.inject({
        method: "POST",
        url: `/v1/public/tenants/${slug}/slots/search`,
        payload,
      });
    }

    it("serves slots to a stranger with no session", async () => {
      const site = await clinic("public-slots");
      await setHours(site, MONDAY_MORNING);

      const response = await publicSearch(site.slug, {
        serviceId: site.serviceId,
        dateFrom: MONDAY,
        dateTo: MONDAY,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(localStarts(response.json().items as { startAt: string }[])).toEqual(
        everyQuarter("09:00", "11:00"),
      );
    });

    it("hides a provider whose online booking is switched off, while staff still see them", async () => {
      const site = await clinic("public-slots-offline");
      await setHours(site, MONDAY_MORNING);

      await app.inject({
        method: "PATCH",
        url: `/v1/providers/${site.providerId}`,
        headers: as(site.cookie, site.tenantId),
        payload: { onlineBookingEnabled: false },
      });

      const publicResponse = await publicSearch(site.slug, {
        serviceId: site.serviceId,
        dateFrom: MONDAY,
        dateTo: MONDAY,
      });
      expect(publicResponse.json().items).toEqual([]);

      // The front desk can still book them over the phone.
      expect(localStarts(await searchSlots(site))).toEqual(everyQuarter("09:00", "11:00"));
    });

    it("hides an inactive service", async () => {
      const site = await clinic("public-slots-inactive");
      await setHours(site, MONDAY_MORNING);

      await app.inject({
        method: "PATCH",
        url: `/v1/services/${site.serviceId}`,
        headers: as(site.cookie, site.tenantId),
        payload: { active: false },
      });

      const response = await publicSearch(site.slug, {
        serviceId: site.serviceId,
        dateFrom: MONDAY,
        dateTo: MONDAY,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe(ErrorCodes.SERVICE_NOT_FOUND);
    });

    it("gives a suspended tenant the same 404 as a slug that never existed", async () => {
      const site = await clinic("public-slots-suspended");
      await setHours(site, MONDAY_MORNING);

      await app.prisma.tenant.update({
        where: { id: site.tenantId },
        data: { status: "SUSPENDED" },
      });

      const suspended = await publicSearch(site.slug, {
        serviceId: site.serviceId,
        dateFrom: MONDAY,
        dateTo: MONDAY,
      });
      const nonexistent = await publicSearch(`no-such-clinic-${RUN}`, {
        serviceId: site.serviceId,
        dateFrom: MONDAY,
        dateTo: MONDAY,
      });

      expect(suspended.statusCode).toBe(404);
      expect(nonexistent.statusCode).toBe(404);
      expect(suspended.json().error.message).toBe(nonexistent.json().error.message);
    });
  });
});
