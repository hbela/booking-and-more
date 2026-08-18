import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

    const providerId = await create("/v1/providers", {
      displayName: "Dr. Kovács Anna",
      email: "anna@example.test",
    });
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

  /**
   * The version marker the whole-set save requires
   * (docs/phase-3-4-diary-delegation.md §2.14).
   *
   * Every helper here reads before it writes, which is the rule the fingerprint
   * enforces — so a test that wanted to write blind now has to say so
   * explicitly, by passing `expectedFingerprint` itself.
   */
  async function fingerprintOf(site: {
    cookie: string;
    tenantId: string;
    providerId: string;
  }): Promise<string> {
    const read = await app.inject({
      method: "GET",
      url: `/v1/providers/${site.providerId}/working-hours`,
      headers: as(site.cookie, site.tenantId),
    });

    expect(read.statusCode, read.body).toBe(200);
    return read.json().fingerprint as string;
  }

  async function setHours(
    site: { cookie: string; tenantId: string; providerId: string },
    workingHours: Record<string, unknown>[],
    overrides: Record<string, unknown> = {},
  ) {
    return app.inject({
      method: "PUT",
      url: `/v1/providers/${site.providerId}/working-hours`,
      headers: as(site.cookie, site.tenantId),
      payload: {
        workingHours,
        expectedFingerprint: await fingerprintOf(site),
        ...overrides,
      },
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

    /**
     * Provenance for the "last changed by" line
     * (docs/phase-3-4-diary-delegation.md §2.14).
     *
     * `vi.waitFor` and not a bare assertion because `request.audit()` is
     * deliberately fire-and-forget (`audit.plugin.ts`) — the row lands shortly
     * *after* the PUT responds. That is the feature's real consistency model,
     * not a test artefact, so the test asserts the same thing the screen sees
     * rather than reaching past it into the database.
     */
    it("reports who last saved the week, and nobody before the first save", async () => {
      const site = await clinic("hours-provenance");

      const readHours = async () =>
        app.inject({
          method: "GET",
          url: `/v1/providers/${site.providerId}/working-hours`,
          headers: as(site.cookie, site.tenantId),
        });

      // `clinic` creates the provider but never saves a week, so there is no
      // audit row to attribute. Null is the honest answer, and every diary that
      // existed before this shipped is in exactly this state.
      expect((await readHours()).json().lastChange).toBeNull();

      await setHours(site, MONDAY_MORNING);

      await vi.waitFor(
        async () => {
          const lastChange = (await readHours()).json().lastChange as {
            at: string;
            by: { userId: string; name: string } | null;
          } | null;

          expect(lastChange).not.toBeNull();
          // The acting user, resolved by id and given a name the screen can
          // print. `signUp` names the account after the label.
          expect(lastChange!.by).toEqual({ userId: site.id, name: "hours-provenance" });
          expect(Date.parse(lastChange!.at)).not.toBeNaN();
        },
        { timeout: 5000, interval: 100 },
      );
    });

    /**
     * Optimistic concurrency. docs/phase-3-4-diary-delegation.md §2.14.
     *
     * The defect this closes: the save replaces the whole set, so a body built
     * from a stale read silently reverted whoever saved in between — and diary
     * delegation made a second editor the expected arrangement rather than a
     * rarity.
     */
    describe("the version check", () => {
      it("refuses a body built from a read that is no longer current", async () => {
        const site = await clinic("hours-stale");

        // What one editor is holding when the other saves.
        const stale = await fingerprintOf(site);

        await setHours(site, [{ weekday: 1, startTime: "09:00", endTime: "12:00" }]);

        const clobber = await app.inject({
          method: "PUT",
          url: `/v1/providers/${site.providerId}/working-hours`,
          headers: as(site.cookie, site.tenantId),
          payload: {
            workingHours: [{ weekday: 3, startTime: "14:00", endTime: "18:00" }],
            expectedFingerprint: stale,
          },
        });

        expect(clobber.statusCode, clobber.body).toBe(409);
        expect(clobber.json().error.code).toBe(ErrorCodes.SCHEDULE_MODIFIED);

        // And, the point of the whole thing: the first save survived.
        const after = await app.inject({
          method: "GET",
          url: `/v1/providers/${site.providerId}/working-hours`,
          headers: as(site.cookie, site.tenantId),
        });
        expect(after.json().items).toHaveLength(1);
        expect(after.json().items[0].startTime).toBe("09:00");
      });

      it("names the other editor in the refusal", async () => {
        const site = await clinic("hours-stale-who");
        const stale = await fingerprintOf(site);
        await setHours(site, MONDAY_MORNING);

        // The audit row is written fire-and-forget, so who-changed-it can lag
        // the refusal. Retried rather than asserted once, because that lag is
        // the real behaviour and not a flake (§2.14.2).
        await vi.waitFor(
          async () => {
            const refused = await app.inject({
              method: "PUT",
              url: `/v1/providers/${site.providerId}/working-hours`,
              headers: as(site.cookie, site.tenantId),
              payload: { workingHours: [], expectedFingerprint: stale },
            });

            expect(refused.statusCode).toBe(409);
            expect(refused.json().error.details.lastChange.by).toEqual({
              userId: site.id,
              name: "hours-stale-who",
            });
          },
          { timeout: 5000, interval: 100 },
        );
      });

      it("accepts a fingerprint that is still current, twice in a row", async () => {
        const site = await clinic("hours-sequential");

        // The PUT hands back the new version, so a second save needs no GET.
        const first = await setHours(site, MONDAY_MORNING);
        expect(first.statusCode, first.body).toBe(200);

        const second = await app.inject({
          method: "PUT",
          url: `/v1/providers/${site.providerId}/working-hours`,
          headers: as(site.cookie, site.tenantId),
          payload: {
            workingHours: [{ weekday: 2, startTime: "10:00", endTime: "16:00" }],
            expectedFingerprint: first.json().fingerprint as string,
          },
        });

        expect(second.statusCode, second.body).toBe(200);
        expect(second.json().items[0].weekday).toBe(2);
      });

      it("treats a re-save of an identical week as no conflict at all", async () => {
        const site = await clinic("hours-identical");
        const before = await fingerprintOf(site);

        // Same content, new row ids — the fingerprint is over content, so the
        // holder of `before` has nothing of anyone's to revert (§2.14.2).
        await setHours(site, MONDAY_MORNING);
        await setHours(site, MONDAY_MORNING);

        expect(await fingerprintOf(site)).not.toBe(before);

        const again = await setHours(site, MONDAY_MORNING);
        expect(again.statusCode, again.body).toBe(200);
      });

      it("refuses a save that names no version at all", async () => {
        const site = await clinic("hours-no-fingerprint");

        const blind = await app.inject({
          method: "PUT",
          url: `/v1/providers/${site.providerId}/working-hours`,
          headers: as(site.cookie, site.tenantId),
          payload: { workingHours: MONDAY_MORNING },
        });

        expect(blind.statusCode, blind.body).toBe(400);
        expect(blind.json().error.code).toBe(ErrorCodes.SCHEDULE_FINGERPRINT_REQUIRED);
      });

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
        // A literal, because there is no honest way to obtain one: the GET that
        // issues fingerprints 404s for this caller too. The point of the test is
        // that the diary is invisible, and it must stay a 404 rather than
        // becoming a hint that the field was the problem.
        payload: { workingHours: MONDAY_MORNING, expectedFingerprint: "never-read" },
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

      // Invited as an ADMIN and promoted, because PROVIDER cannot be invited
      // from this route: it carries no diary, so the membership it creates can
      // do nothing (phase-9-provider-onboarding §2.11). Promoting an existing
      // member is a different act and still allowed. The route that invites a
      // provider *with* their diary is POST /v1/providers/:id/invitation, and
      // it has its own suite.
      const invited = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(site.cookie, site.tenantId),
        payload: { email: member.email, role: "ADMIN" },
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
        payload: { role: "PROVIDER", providerId: site.providerId },
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
        payload: {
          workingHours: MONDAY_MORNING,
          expectedFingerprint: await fingerprintOf({
            cookie: member.cookie,
            tenantId: site.tenantId,
            providerId: site.providerId,
          }),
        },
      });

      expect(response.statusCode, response.body).toBe(200);
    });

    it("answers a caller who may not touch this diary with 403, not with the missing version", async () => {
      // The ordering §2.14 turns on, and the reason `expectedFingerprint` is
      // optional in the Zod schema: Fastify validates the body *before* the
      // preHandler runs, so a required field would send somebody with no
      // permission on this diary off to look for it instead of telling them.
      const { site, member } = await withLinkedProvider("hours-403-first");

      const other = await app.inject({
        method: "POST",
        url: "/v1/providers",
        headers: as(site.cookie, site.tenantId),
        payload: { displayName: "Dr. Nagy Béla" },
      });

      const refused = await app.inject({
        method: "PUT",
        url: `/v1/providers/${other.json().id as string}/working-hours`,
        headers: as(member.cookie, site.tenantId),
        payload: { workingHours: MONDAY_MORNING },
      });

      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error.code).toBe(ErrorCodes.FORBIDDEN);
    });

    it("refuses a provider editing somebody else's diary", async () => {
      const { site, member } = await withLinkedProvider("own-other");

      const otherProvider = await app.inject({
        method: "POST",
        url: "/v1/providers",
        headers: as(site.cookie, site.tenantId),
        payload: { displayName: "Dr. Nagy Béla", email: "bela@example.test" },
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
        payload: { email: member.email, role: "ADMIN" },
      });
      const token = (invited.json().acceptUrl as string).split("/").pop()!;
      await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(member.cookie),
        payload: { token },
      });

      // Promoted to PROVIDER and deliberately left unlinked — the state the
      // generic invite route used to produce on its own, and which is now
      // reachable only on purpose.
      const membership = await app.prisma.membership.findFirst({
        where: { tenantId: site.tenantId, userId: member.id },
      });
      await app.inject({
        method: "PATCH",
        url: `/v1/members/${membership!.id}`,
        headers: as(site.cookie, site.tenantId),
        payload: { role: "PROVIDER" },
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
        payload: { displayName: "Someone Else", email: "someone@example.test" },
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

    /**
     * Rewritten for diary delegation (docs/phase-3-4-diary-delegation.md §2.9).
     *
     * It used to assert "an assistant reads any schedule but changes none",
     * which is exactly the shape the feature removes: reading is now the same
     * question as changing, and an assistant reaches only the diaries handed to
     * them. Three cases, because the interesting one is the middle: a grant that
     * covers bookings must not open the schedule.
     */
    describe("an assistant and somebody else's schedule", () => {
      async function assistantOf(
        site: Awaited<ReturnType<typeof clinic>>,
        label: string,
      ): Promise<{ cookie: string; membershipId: string }> {
        const member = await signUp(`${label}-member`);
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

        const membership = await app.prisma.membership.findFirst({
          where: { tenantId: site.tenantId, user: { email: member.email } },
          select: { id: true },
        });

        return { cookie: member.cookie, membershipId: membership!.id };
      }

      function grant(
        site: Awaited<ReturnType<typeof clinic>>,
        membershipId: string,
        scopes: string[],
      ) {
        return app.inject({
          method: "PUT",
          url: `/v1/providers/${site.providerId}/delegations/${membershipId}`,
          headers: as(site.cookie, site.tenantId),
          payload: { scopes },
        });
      }

      it("refuses an assistant nobody has delegated to, on the read as well", async () => {
        const site = await clinic("assistant-none");
        await setHours(site, MONDAY_MORNING);
        const assistant = await assistantOf(site, "assistant-none");

        const read = await app.inject({
          method: "GET",
          url: `/v1/providers/${site.providerId}/working-hours`,
          headers: as(assistant.cookie, site.tenantId),
        });
        expect(read.statusCode, read.body).toBe(403);

        const write = await app.inject({
          method: "PUT",
          url: `/v1/providers/${site.providerId}/working-hours`,
          headers: as(assistant.cookie, site.tenantId),
          payload: { workingHours: [] },
        });
        expect(write.statusCode, write.body).toBe(403);
      });

      it("still refuses one holding only a BOOKINGS grant", async () => {
        // The case the whole scope split exists for: handing over the
        // appointments must not hand over the schedule.
        const site = await clinic("assistant-bookings");
        await setHours(site, MONDAY_MORNING);
        const assistant = await assistantOf(site, "assistant-bookings");

        const granted = await grant(site, assistant.membershipId, ["BOOKINGS"]);
        expect(granted.statusCode, granted.body).toBe(200);

        const read = await app.inject({
          method: "GET",
          url: `/v1/providers/${site.providerId}/working-hours`,
          headers: as(assistant.cookie, site.tenantId),
        });
        expect(read.statusCode, read.body).toBe(403);

        const write = await app.inject({
          method: "PUT",
          url: `/v1/providers/${site.providerId}/working-hours`,
          headers: as(assistant.cookie, site.tenantId),
          payload: { workingHours: [] },
        });
        expect(write.statusCode, write.body).toBe(403);
      });

      it("lets one holding an AVAILABILITY grant both read and change it", async () => {
        const site = await clinic("assistant-availability");
        await setHours(site, MONDAY_MORNING);
        const assistant = await assistantOf(site, "assistant-availability");

        const granted = await grant(site, assistant.membershipId, ["AVAILABILITY"]);
        expect(granted.statusCode, granted.body).toBe(200);

        const read = await app.inject({
          method: "GET",
          url: `/v1/providers/${site.providerId}/working-hours`,
          headers: as(assistant.cookie, site.tenantId),
        });
        expect(read.statusCode, read.body).toBe(200);
        expect(read.json().items).toHaveLength(1);

        const write = await app.inject({
          method: "PUT",
          url: `/v1/providers/${site.providerId}/working-hours`,
          headers: as(assistant.cookie, site.tenantId),
          payload: {
            workingHours: [],
            expectedFingerprint: await fingerprintOf({
              cookie: assistant.cookie,
              tenantId: site.tenantId,
              providerId: site.providerId,
            }),
          },
        });
        expect(write.statusCode, write.body).toBe(200);
      });

      it("stops conferring anything the moment the grant is revoked", async () => {
        const site = await clinic("assistant-revoke");
        await setHours(site, MONDAY_MORNING);
        const assistant = await assistantOf(site, "assistant-revoke");
        await grant(site, assistant.membershipId, ["AVAILABILITY"]);

        const before = await app.inject({
          method: "GET",
          url: `/v1/providers/${site.providerId}/working-hours`,
          headers: as(assistant.cookie, site.tenantId),
        });
        expect(before.statusCode, before.body).toBe(200);

        const revoked = await app.inject({
          method: "DELETE",
          url: `/v1/providers/${site.providerId}/delegations/${assistant.membershipId}`,
          headers: as(site.cookie, site.tenantId),
        });
        expect(revoked.statusCode, revoked.body).toBe(204);

        // Same session, no re-authentication: the set is resolved per request,
        // so there is no cache to wait out (§2.7).
        const after = await app.inject({
          method: "GET",
          url: `/v1/providers/${site.providerId}/working-hours`,
          headers: as(assistant.cookie, site.tenantId),
        });
        expect(after.statusCode, after.body).toBe(403);
      });
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
        payload: { displayName: "Dr. Nagy Béla", email: "bela2@example.test" },
      });
      const secondId = second.json().id as string;

      await app.inject({
        method: "PUT",
        url: `/v1/providers/${secondId}/services`,
        headers: as(site.cookie, site.tenantId),
        payload: { services: [{ serviceId: site.serviceId }] },
      });

      await setHours(site, MONDAY_MORNING);
      await setHours({ ...site, providerId: secondId }, [
        { weekday: 1, startTime: "10:00", endTime: "12:00" },
      ]);

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
  // Asking about one location
  // -------------------------------------------------------------------------

  describe("searching at a named location", () => {
    // There was briefly a `service_locations` table answering "is this service
    // offered here?" independently. It was removed: a location is one of the
    // organization's sites, and whether a service is offered there follows from
    // whether a provider who offers it works there. These two cases pin that
    // down, because it is the rule the table used to override.

    it("offers a service at a location nobody has said anything about", async () => {
      const site = await clinic("loc-unrestricted");
      await setHours(site, MONDAY_MORNING);

      const slots = await searchSlots(site, { locationId: site.locationId });
      expect(slots.length).toBeGreaterThan(0);
    });

    it("returns nothing at a location the provider does not work at", async () => {
      const site = await clinic("loc-elsewhere");
      await setHours(site, MONDAY_MORNING);

      const elsewhere = await app.inject({
        method: "POST",
        url: "/v1/locations",
        headers: as(site.cookie, site.tenantId),
        payload: { name: "Annexe", type: "PHYSICAL", addressLine1: "Fő utca 2" },
      });
      const elsewhereId = elsewhere.json().id as string;

      expect(await searchSlots(site, { locationId: elsewhereId })).toEqual([]);

      // And asking without a location still finds them: the question is where,
      // not whether.
      expect((await searchSlots(site)).length).toBeGreaterThan(0);
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

  // -------------------------------------------------------------------------
  // Schedule changes against existing bookings
  // -------------------------------------------------------------------------

  describe("bookings a schedule change would strand", () => {
    /**
     * docs/phase-3-4-schedule-conflicts.md.
     *
     * The engine proves the arithmetic. What is proved here is that the right
     * diary is read, that the refusal carries enough to act on, and that an
     * acknowledgement gets through — none of which the engine can see.
     */

    /** Books the 10:00 Monday appointment, on a clinic with Monday morning hours. */
    async function bookMondayMorning(label: string) {
      const site = await clinic(label);

      const opened = await setHours(site, MONDAY_MORNING);
      expect(opened.statusCode, opened.body).toBe(200);

      const booking = await app.inject({
        method: "POST",
        url: "/v1/bookings",
        headers: {
          ...as(site.cookie, site.tenantId),
          "idempotency-key": randomBytes(12).toString("hex"),
        },
        payload: {
          providerId: site.providerId,
          serviceId: site.serviceId,
          startAt: `${MONDAY}T08:00:00.000Z`, // 10:00 Budapest
          customer: { fullName: "Nagy Béla", email: `patient-${label}-${RUN}@example.test` },
        },
      });

      expect(booking.statusCode, booking.body).toBe(201);
      return { site, booking: booking.json<{ id: string; reference: string }>() };
    }

    it("refuses a save that would leave a booking outside the new hours", async () => {
      const { site, booking } = await bookMondayMorning("strand-hours");

      // Afternoons only, which the 10:00 appointment is no longer inside.
      const narrowed = await setHours(site, [
        { weekday: 1, startTime: "13:00", endTime: "17:00" },
      ]);

      expect(narrowed.statusCode, narrowed.body).toBe(409);

      const error = narrowed.json().error;
      expect(error.code).toBe(ErrorCodes.SCHEDULE_CONFLICTS_BOOKINGS);
      expect(error.details.affectedBookings).toHaveLength(1);
      expect(error.details.affectedBookings[0]).toMatchObject({
        id: booking.id,
        reference: booking.reference,
        reason: "OUTSIDE_WORKING_HOURS",
      });
      // Enough to recognise the appointment without a second request.
      expect(error.details.affectedBookings[0].customerName).toBe("Nagy Béla");
    });

    it("changes nothing when it refuses", async () => {
      // A 409 that had already written the hours would be worse than no check.
      const { site } = await bookMondayMorning("strand-atomic");

      await setHours(site, [{ weekday: 1, startTime: "13:00", endTime: "17:00" }]);

      const stored = await app.inject({
        method: "GET",
        url: `/v1/providers/${site.providerId}/working-hours`,
        headers: as(site.cookie, site.tenantId),
      });

      expect(stored.json().items).toHaveLength(1);
      expect(stored.json().items[0].startTime).toBe("09:00");
    });

    it("lets the same change through once it is acknowledged", async () => {
      const { site } = await bookMondayMorning("strand-ack");

      const acknowledged = await setHours(
        site,
        [{ weekday: 1, startTime: "13:00", endTime: "17:00" }],
        { acknowledgeAffectedBookings: true },
      );

      expect(acknowledged.statusCode, acknowledged.body).toBe(200);
      expect(acknowledged.json().items[0].startTime).toBe("13:00");
    });

    it("says nothing about a change that strands nobody", async () => {
      // The common case, and the one that must stay quiet: a dialog on every
      // save is a dialog nobody reads.
      const { site } = await bookMondayMorning("strand-none");

      const widened = await setHours(site, [{ weekday: 1, startTime: "08:00", endTime: "18:00" }]);

      expect(widened.statusCode, widened.body).toBe(200);
    });

    it("ignores a booking that has been cancelled", async () => {
      const { site, booking } = await bookMondayMorning("strand-cancelled");

      await app.prisma.booking.update({
        where: { id: booking.id },
        data: { status: "CANCELLED", cancelledAt: new Date() },
      });

      const narrowed = await setHours(site, [
        { weekday: 1, startTime: "13:00", endTime: "17:00" },
      ]);

      expect(narrowed.statusCode, narrowed.body).toBe(200);
    });

    it("ignores a booking already in the past", async () => {
      // §2.3. Nobody can fix last month, and warning about it makes every save
      // noisy forever.
      const { site, booking } = await bookMondayMorning("strand-past");

      await app.prisma.booking.update({
        where: { id: booking.id },
        data: {
          startAt: new Date("2026-01-05T09:00:00.000Z"),
          endAt: new Date("2026-01-05T10:00:00.000Z"),
        },
      });

      const narrowed = await setHours(site, [
        { weekday: 1, startTime: "13:00", endTime: "17:00" },
      ]);

      expect(narrowed.statusCode, narrowed.body).toBe(200);
    });

    it("treats switching a period off the same as deleting it", async () => {
      // The search ignores an inactive row, so judging against one would let an
      // owner strand a booking by unticking a box.
      const { site } = await bookMondayMorning("strand-inactive");

      const deactivated = await setHours(site, [
        { weekday: 1, startTime: "09:00", endTime: "12:00", active: false },
      ]);

      expect(deactivated.statusCode).toBe(409);
      expect(deactivated.json().error.code).toBe(ErrorCodes.SCHEDULE_CONFLICTS_BOOKINGS);
    });

    it("refuses time off booked over an appointment, and names it as such", async () => {
      // §2.5, and the likelier of the two paths.
      const { site } = await bookMondayMorning("strand-timeoff");

      const timeOff = await app.inject({
        method: "POST",
        url: `/v1/providers/${site.providerId}/availability-exceptions`,
        headers: as(site.cookie, site.tenantId),
        payload: {
          type: "UNAVAILABLE",
          startAt: `${MONDAY}T06:00:00.000Z`,
          endAt: `${MONDAY}T10:00:00.000Z`,
        },
      });

      expect(timeOff.statusCode, timeOff.body).toBe(409);

      const error = timeOff.json().error;
      expect(error.code).toBe(ErrorCodes.SCHEDULE_CONFLICTS_BOOKINGS);
      // The other reason: the hours still cover it, a closure was laid on top.
      expect(error.details.affectedBookings[0].reason).toBe("BLOCKED_BY_EXCEPTION");
    });

    it("lets an extra opening through without asking", async () => {
      // ADDITIONAL_AVAILABILITY only ever adds time and can strand nothing.
      const { site } = await bookMondayMorning("strand-opening");

      const opening = await app.inject({
        method: "POST",
        url: `/v1/providers/${site.providerId}/availability-exceptions`,
        headers: as(site.cookie, site.tenantId),
        payload: {
          type: "ADDITIONAL_AVAILABILITY",
          startAt: `${MONDAY}T14:00:00.000Z`,
          endAt: `${MONDAY}T16:00:00.000Z`,
        },
      });

      expect(opening.statusCode, opening.body).toBe(201);
    });

    it("does not count a closure against itself when it is being shrunk", async () => {
      // A PATCH that moves a closure *off* a booking must not be refused for the
      // booking it is being moved off.
      const { site } = await bookMondayMorning("strand-shrink");

      const created = await app.inject({
        method: "POST",
        url: `/v1/providers/${site.providerId}/availability-exceptions`,
        headers: as(site.cookie, site.tenantId),
        payload: {
          type: "UNAVAILABLE",
          startAt: `${MONDAY}T06:00:00.000Z`,
          endAt: `${MONDAY}T10:00:00.000Z`,
          acknowledgeAffectedBookings: true,
        },
      });
      expect(created.statusCode, created.body).toBe(201);

      const shrunk = await app.inject({
        method: "PATCH",
        url: `/v1/availability-exceptions/${created.json().id as string}`,
        headers: as(site.cookie, site.tenantId),
        payload: { endAt: `${MONDAY}T07:00:00.000Z` },
      });

      expect(shrunk.statusCode, shrunk.body).toBe(200);
    });

    it("refuses to read another tenant's diary while answering", async () => {
      // The affected list is assembled from bookings, and rule 5 applies to that
      // read like any other.
      const mine = await bookMondayMorning("strand-mine");
      const theirs = await clinic("strand-theirs");

      const crossed = await app.inject({
        method: "PUT",
        url: `/v1/providers/${mine.site.providerId}/working-hours`,
        headers: as(theirs.cookie, theirs.tenantId),
        // See the note on the other cross-tenant write: no fingerprint is
        // obtainable, and the answer must stay 404 regardless.
        payload: { workingHours: [], expectedFingerprint: "never-read" },
      });

      expect(crossed.statusCode).toBe(404);
    });
  });

  describe("bookings already outside the schedule", () => {
    it("marks one on the list, and clears it when the hours come back", async () => {
      // §2.6, and the standing half of the pair: however a booking got stranded,
      // it shows up the first time anybody looks at the diary.
      const site = await clinic("badge");
      await setHours(site, MONDAY_MORNING);

      const booking = await app.inject({
        method: "POST",
        url: "/v1/bookings",
        headers: {
          ...as(site.cookie, site.tenantId),
          "idempotency-key": randomBytes(12).toString("hex"),
        },
        payload: {
          providerId: site.providerId,
          serviceId: site.serviceId,
          startAt: `${MONDAY}T08:00:00.000Z`,
          customer: { fullName: "Nagy Béla", email: `badge-${RUN}@example.test` },
        },
      });
      expect(booking.statusCode, booking.body).toBe(201);

      const list = async () => {
        const response = await app.inject({
          method: "GET",
          url: "/v1/bookings",
          headers: as(site.cookie, site.tenantId),
        });
        expect(response.statusCode, response.body).toBe(200);
        return response.json().items as { id: string; outsideSchedule: string | null }[];
      };

      expect((await list())[0]?.outsideSchedule).toBeNull();

      await setHours(site, [{ weekday: 1, startTime: "13:00", endTime: "17:00" }], {
        acknowledgeAffectedBookings: true,
      });

      expect((await list())[0]?.outsideSchedule).toBe("OUTSIDE_WORKING_HOURS");

      // Derived, not stored: putting the hours back clears it with no write to
      // the booking at all.
      await setHours(site, MONDAY_MORNING);

      expect((await list())[0]?.outsideSchedule).toBeNull();
    });
  });
});
