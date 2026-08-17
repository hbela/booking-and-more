import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "@bam/config";
import { ErrorCodes } from "@bam/contracts";
import { buildApp, type AppInstance } from "./app.js";

/**
 * Diary delegation through real HTTP. docs/phase-3-4-diary-delegation.md.
 *
 * The rules themselves are proved in `@bam/auth`'s policy.test.ts, where they
 * can be exercised without a database. What is proved here is everything that
 * pure test cannot see: that the grant rows reach the actor at all, that they
 * are loaded for the right tenant, that revoking one takes effect without a new
 * session, and — the case the whole design turns on — that a delegate cannot
 * hand the diary on.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];

/** Random and file-prefixed — see the note in catalogue.test.ts. */
const RUN = `dg${randomBytes(4).toString("hex")}`;

/** A Monday far enough ahead to clear any default booking window. */
const MONDAY = "2026-09-07";

describe.skipIf(!databaseUrl)("diary delegation", () => {
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
    const tenants = await app.prisma.tenant.findMany({
      where: { slug: { endsWith: RUN } },
      select: { id: true },
    });
    const tenantIds = tenants.map((tenant) => tenant.id);

    if (tenantIds.length > 0) {
      // Explicit order, copied from booking.test.ts: a reservation must name
      // either a hold or a booking, so deleting the booking first nulls its
      // reference and trips `capacity_reservations_have_an_owner`. Bookings also
      // hold a RESTRICT reference to customers.
      const where = { tenantId: { in: tenantIds } };
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

  function key(): Record<string, string> {
    return { "idempotency-key": randomBytes(12).toString("hex") };
  }

  interface Clinic {
    owner: { cookie: string; email: string; id: string };
    tenantId: string;
    slug: string;
    /** Two diaries, because "only the granted one" needs a second to exclude. */
    providerId: string;
    otherProviderId: string;
    serviceId: string;
    locationId: string;
  }

  /** A clinic in UTC with two providers, both working Monday 09:00–17:00. */
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
      email: `${label}-anna-${RUN}@example.test`,
      timezone: "UTC",
    });
    const otherProviderId = await create("/v1/providers", {
      displayName: "Dr. Nagy Béla",
      email: `${label}-bela-${RUN}@example.test`,
      timezone: "UTC",
    });
    const serviceId = await create("/v1/services", {
      name: "Consultation",
      durationMinutes: 60,
    });
    const locationId = await create("/v1/locations", {
      name: "Main surgery",
      type: "PHYSICAL",
      addressLine1: "Váci út 1",
      timezone: "UTC",
    });

    for (const id of [providerId, otherProviderId]) {
      await app.inject({
        method: "PUT",
        url: `/v1/providers/${id}/services`,
        headers: as(owner.cookie, tenantId),
        payload: { services: [{ serviceId }] },
      });
      await app.inject({
        method: "PUT",
        url: `/v1/providers/${id}/locations`,
        headers: as(owner.cookie, tenantId),
        payload: { locations: [{ locationId }] },
      });
      const hours = await app.inject({
        method: "PUT",
        url: `/v1/providers/${id}/working-hours`,
        headers: as(owner.cookie, tenantId),
        payload: { workingHours: [{ weekday: 1, startTime: "09:00", endTime: "17:00" }] },
      });
      expect(hours.statusCode, hours.body).toBe(200);
    }

    return { owner, tenantId, slug, providerId, otherProviderId, serviceId, locationId };
  }

  /**
   * Invite somebody into `site` with `role`, accept, and return their membership.
   *
   * PROVIDER goes in through Prisma rather than the invitation route, which
   * refuses it on purpose: a provider is invited from their own row so the
   * invitation carries the diary (phase-9-provider-onboarding §2.11). Exercising
   * that path is that suite's job; here it is a fixture.
   */
  async function member(
    site: { cookie?: string; owner?: { cookie: string }; tenantId: string },
    label: string,
    role: string,
    providerId?: string,
  ): Promise<{ cookie: string; email: string; id: string; membershipId: string }> {
    const ownerCookie = site.owner?.cookie ?? site.cookie!;
    const person = await signUp(label);

    if (role === "PROVIDER") {
      const membership = await app.prisma.membership.create({
        data: {
          tenantId: site.tenantId,
          userId: person.id,
          role: "PROVIDER",
          status: "ACTIVE",
          joinedAt: new Date(),
          ...(providerId === undefined ? {} : { providerId }),
        },
        select: { id: true },
      });

      return { ...person, membershipId: membership.id };
    }

    const invited = await app.inject({
      method: "POST",
      url: "/v1/members/invitations",
      headers: as(ownerCookie, site.tenantId),
      payload: { email: person.email, role },
    });
    expect(invited.statusCode, invited.body).toBe(201);

    const token = (invited.json().acceptUrl as string).split("/").pop()!;
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/invitations/accept",
      headers: as(person.cookie),
      payload: { token },
    });
    expect(accepted.statusCode, accepted.body).toBeLessThan(400);

    const membership = await app.prisma.membership.findFirst({
      where: { tenantId: site.tenantId, userId: person.id },
      select: { id: true },
    });

    return { ...person, membershipId: membership!.id };
  }

  function grant(
    site: Clinic,
    providerId: string,
    membershipId: string,
    scopes: string[],
    cookie?: string,
  ) {
    return app.inject({
      method: "PUT",
      url: `/v1/providers/${providerId}/delegations/${membershipId}`,
      headers: as(cookie ?? site.owner.cookie, site.tenantId),
      payload: { scopes },
    });
  }

  function revoke(site: Clinic, providerId: string, membershipId: string, cookie?: string) {
    return app.inject({
      method: "DELETE",
      url: `/v1/providers/${providerId}/delegations/${membershipId}`,
      headers: as(cookie ?? site.owner.cookie, site.tenantId),
    });
  }

  /** A confirmed booking on `providerId`, created by the owner. */
  async function bookingOn(site: Clinic, providerId: string, hour: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/bookings",
      headers: { ...as(site.owner.cookie, site.tenantId), ...key() },
      payload: {
        providerId,
        serviceId: site.serviceId,
        startAt: `${MONDAY}T${hour}:00:00.000Z`,
        customer: { fullName: "Walk-in" },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  // -------------------------------------------------------------------------
  // Who may grant
  // -------------------------------------------------------------------------

  describe("who may hand a diary over", () => {
    it("refuses a delegate, so a diary cannot be passed on", async () => {
      // The case the whole design turns on (§2.3). `canDelegateProviderDiary` is
      // `canForProvider` without a delegated branch, and this is that omission
      // observed over HTTP.
      const site = await clinic("nopassing");
      const reka = await member(site, "nopassing-reka", "ASSISTANT");
      const eva = await member(site, "nopassing-eva", "ASSISTANT");

      const granted = await grant(site, site.providerId, reka.membershipId, [
        "AVAILABILITY",
        "BOOKINGS",
      ]);
      expect(granted.statusCode, granted.body).toBe(200);

      const passedOn = await grant(
        site,
        site.providerId,
        eva.membershipId,
        ["BOOKINGS"],
        reka.cookie,
      );
      expect(passedOn.statusCode, passedOn.body).toBe(403);

      // And they cannot even see who else holds it.
      const list = await app.inject({
        method: "GET",
        url: `/v1/providers/${site.providerId}/delegations`,
        headers: as(reka.cookie, site.tenantId),
      });
      expect(list.statusCode, list.body).toBe(403);
    });

    it("lets a provider hand over their own diary and nobody else's", async () => {
      const site = await clinic("providergrant");
      const reka = await member(site, "providergrant-reka", "ASSISTANT");
      const doctor = await member(site, "providergrant-doc", "PROVIDER", site.providerId);

      const own = await grant(
        site,
        site.providerId,
        reka.membershipId,
        ["BOOKINGS"],
        doctor.cookie,
      );
      expect(own.statusCode, own.body).toBe(200);

      const colleagues = await grant(
        site,
        site.otherProviderId,
        reka.membershipId,
        ["BOOKINGS"],
        doctor.cookie,
      );
      expect(colleagues.statusCode, colleagues.body).toBe(403);
    });

    it("refuses a target that cannot hold a diary", async () => {
      const site = await clinic("ineligible");

      const admin = await member(site, "ineligible-admin", "ADMIN");
      const asAdmin = await grant(site, site.providerId, admin.membershipId, ["BOOKINGS"]);
      expect(asAdmin.statusCode, asAdmin.body).toBe(422);
      expect(asAdmin.json().error.code).toBe(ErrorCodes.DELEGATION_TARGET_INELIGIBLE);

      // Invited but not joined: a membership that grants nothing yet.
      const pending = await signUp("ineligible-pending");
      const invited = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(site.owner.cookie, site.tenantId),
        payload: { email: pending.email, role: "ASSISTANT" },
      });
      expect(invited.statusCode, invited.body).toBe(201);
      const pendingMembership = await app.prisma.membership.create({
        data: {
          tenantId: site.tenantId,
          userId: pending.id,
          role: "ASSISTANT",
          status: "INVITED",
        },
      });

      const asPending = await grant(site, site.providerId, pendingMembership.id, ["BOOKINGS"]);
      expect(asPending.statusCode, asPending.body).toBe(422);

      // And the membership that *is* this diary: it already holds `:own`, so a
      // grant would add nothing and would later be misread as its source.
      const doctor = await member(site, "ineligible-doc", "PROVIDER", site.providerId);
      const asSelf = await grant(site, site.providerId, doctor.membershipId, ["BOOKINGS"]);
      expect(asSelf.statusCode, asSelf.body).toBe(422);
    });

    it("refuses an empty scope set, matching the database CHECK", async () => {
      const site = await clinic("emptyscope");
      const reka = await member(site, "emptyscope-reka", "ASSISTANT");

      const response = await grant(site, site.providerId, reka.membershipId, []);
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().error.code).toBe(ErrorCodes.VALIDATION_FAILED);
    });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  describe("tenant isolation", () => {
    it("treats a membership or diary from another tenant as nonexistent", async () => {
      const here = await clinic("crossgrant-a");
      const there = await clinic("crossgrant-b");
      const stranger = await member(there, "crossgrant-stranger", "ASSISTANT");

      // A membership id from the other tenant: the same 404 as one that never
      // existed (rule 5), never a 403 that would confirm it is real.
      const wrongMember = await grant(here, here.providerId, stranger.membershipId, ["BOOKINGS"]);
      expect(wrongMember.statusCode, wrongMember.body).toBe(404);

      const local = await member(here, "crossgrant-local", "ASSISTANT");
      const wrongProvider = await grant(here, there.providerId, local.membershipId, ["BOOKINGS"]);
      expect(wrongProvider.statusCode, wrongProvider.body).toBe(404);
      expect(wrongProvider.json().error.code).toBe(ErrorCodes.PROVIDER_NOT_FOUND);
    });

    it("does not carry a grant from one tenant into another", async () => {
      // One person, two clinics, granted in exactly one of them. The delegated
      // set hangs off the membership (§2.4), so switching the tenant header
      // resolves a different membership and therefore a different set.
      const here = await clinic("twohats-a");
      const there = await clinic("twohats-b");

      const reka = await member(here, "twohats-reka", "ASSISTANT");

      const alsoThere = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(there.owner.cookie, there.tenantId),
        payload: { email: reka.email, role: "ASSISTANT" },
      });
      expect(alsoThere.statusCode, alsoThere.body).toBe(201);
      const token = (alsoThere.json().acceptUrl as string).split("/").pop()!;
      await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(reka.cookie),
        payload: { token },
      });

      await grant(here, here.providerId, reka.membershipId, ["AVAILABILITY", "BOOKINGS"]);
      await bookingOn(here, here.providerId, "09");
      await bookingOn(there, there.providerId, "09");

      const inHere = await app.inject({
        method: "GET",
        url: `/v1/bookings?from=${MONDAY}&to=${MONDAY}`,
        headers: as(reka.cookie, here.tenantId),
      });
      expect(inHere.statusCode, inHere.body).toBe(200);
      expect(inHere.json().items).toHaveLength(1);

      const inThere = await app.inject({
        method: "GET",
        url: `/v1/bookings?from=${MONDAY}&to=${MONDAY}`,
        headers: as(reka.cookie, there.tenantId),
      });
      expect(inThere.statusCode, inThere.body).toBe(403);

      const scheduleThere = await app.inject({
        method: "PUT",
        url: `/v1/providers/${there.providerId}/working-hours`,
        headers: as(reka.cookie, there.tenantId),
        payload: { workingHours: [] },
      });
      expect(scheduleThere.statusCode, scheduleThere.body).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // What a grant reaches
  // -------------------------------------------------------------------------

  describe("what a grant reaches", () => {
    it("keeps a BOOKINGS grant out of the schedule", async () => {
      const site = await clinic("bookingsonly");
      const reka = await member(site, "bookingsonly-reka", "ASSISTANT");
      await grant(site, site.providerId, reka.membershipId, ["BOOKINGS"]);

      const bookingId = await bookingOn(site, site.providerId, "09");

      const readBooking = await app.inject({
        method: "GET",
        url: `/v1/bookings/${bookingId}`,
        headers: as(reka.cookie, site.tenantId),
      });
      expect(readBooking.statusCode, readBooking.body).toBe(200);

      const writeHours = await app.inject({
        method: "PUT",
        url: `/v1/providers/${site.providerId}/working-hours`,
        headers: as(reka.cookie, site.tenantId),
        payload: { workingHours: [] },
      });
      expect(writeHours.statusCode, writeHours.body).toBe(403);

      const blockTime = await app.inject({
        method: "POST",
        url: `/v1/providers/${site.providerId}/availability-exceptions`,
        headers: as(reka.cookie, site.tenantId),
        payload: {
          type: "UNAVAILABLE",
          startAt: `${MONDAY}T13:00:00.000Z`,
          endAt: `${MONDAY}T14:00:00.000Z`,
        },
      });
      expect(blockTime.statusCode, blockTime.body).toBe(403);
    });

    it("keeps an AVAILABILITY grant out of the bookings", async () => {
      const site = await clinic("availonly");
      const reka = await member(site, "availonly-reka", "ASSISTANT");
      await grant(site, site.providerId, reka.membershipId, ["AVAILABILITY"]);

      const bookingId = await bookingOn(site, site.providerId, "09");

      const readBooking = await app.inject({
        method: "GET",
        url: `/v1/bookings/${bookingId}`,
        headers: as(reka.cookie, site.tenantId),
      });
      expect(readBooking.statusCode, readBooking.body).toBe(403);

      const createBooking = await app.inject({
        method: "POST",
        url: "/v1/bookings",
        headers: { ...as(reka.cookie, site.tenantId), ...key() },
        payload: {
          providerId: site.providerId,
          serviceId: site.serviceId,
          startAt: `${MONDAY}T11:00:00.000Z`,
          customer: { fullName: "Walk-in" },
        },
      });
      expect(createBooking.statusCode, createBooking.body).toBe(403);

      // But the schedule itself is theirs to run. Acknowledged, because the
      // 09:00 booking above is exactly what the conflict check is for.
      const writeHours = await app.inject({
        method: "PUT",
        url: `/v1/providers/${site.providerId}/working-hours`,
        headers: as(reka.cookie, site.tenantId),
        payload: {
          workingHours: [{ weekday: 1, startTime: "10:00", endTime: "17:00" }],
          acknowledgeAffectedBookings: true,
        },
      });
      expect(writeHours.statusCode, writeHours.body).toBe(200);
    });

    it("withholds customer names from an availability-only delegate", async () => {
      // §2.12. A leak that could not exist before the scope split, because
      // nobody could hold one of the two without the other.
      const site = await clinic("noname");
      const reka = await member(site, "noname-reka", "ASSISTANT");
      await grant(site, site.providerId, reka.membershipId, ["AVAILABILITY"]);
      await bookingOn(site, site.providerId, "09");

      const refused = await app.inject({
        method: "PUT",
        url: `/v1/providers/${site.providerId}/working-hours`,
        headers: as(reka.cookie, site.tenantId),
        payload: { workingHours: [{ weekday: 1, startTime: "10:00", endTime: "17:00" }] },
      });

      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.code).toBe(ErrorCodes.SCHEDULE_CONFLICTS_BOOKINGS);

      const affected = refused.json().error.details.affectedBookings as {
        customerName: string | null;
        reference: string;
      }[];
      expect(affected).toHaveLength(1);
      expect(affected[0]!.customerName).toBeNull();
      // Still usable: the reference is what identifies the appointment.
      expect(affected[0]!.reference).toBeTruthy();

      // The owner, who may read the bookings, still gets the name.
      const asOwner = await app.inject({
        method: "PUT",
        url: `/v1/providers/${site.providerId}/working-hours`,
        headers: as(site.owner.cookie, site.tenantId),
        payload: { workingHours: [{ weekday: 1, startTime: "10:00", endTime: "17:00" }] },
      });
      expect(asOwner.statusCode, asOwner.body).toBe(409);
      expect(asOwner.json().error.details.affectedBookings[0].customerName).toBe("Walk-in");
    });
  });

  // -------------------------------------------------------------------------
  // The bookings list is a set, not one id
  // -------------------------------------------------------------------------

  describe("the bookings list", () => {
    it("returns the union of the granted diaries and nothing else", async () => {
      const site = await clinic("union");
      const reka = await member(site, "union-reka", "ASSISTANT");

      const third = await app.inject({
        method: "POST",
        url: "/v1/providers",
        headers: as(site.owner.cookie, site.tenantId),
        payload: {
          displayName: "Dr. Szabó Csilla",
          email: `union-csilla-${RUN}@example.test`,
          timezone: "UTC",
        },
      });
      const thirdId = third.json().id as string;
      await app.inject({
        method: "PUT",
        url: `/v1/providers/${thirdId}/services`,
        headers: as(site.owner.cookie, site.tenantId),
        payload: { services: [{ serviceId: site.serviceId }] },
      });
      await app.inject({
        method: "PUT",
        url: `/v1/providers/${thirdId}/working-hours`,
        headers: as(site.owner.cookie, site.tenantId),
        payload: { workingHours: [{ weekday: 1, startTime: "09:00", endTime: "17:00" }] },
      });

      await grant(site, site.providerId, reka.membershipId, ["BOOKINGS"]);
      await grant(site, site.otherProviderId, reka.membershipId, ["BOOKINGS"]);

      await bookingOn(site, site.providerId, "09");
      await bookingOn(site, site.otherProviderId, "10");
      await bookingOn(site, thirdId, "11");

      const list = await app.inject({
        method: "GET",
        url: `/v1/bookings?from=${MONDAY}&to=${MONDAY}`,
        headers: as(reka.cookie, site.tenantId),
      });

      expect(list.statusCode, list.body).toBe(200);
      const providerIds = (list.json().items as { providerId: string }[]).map(
        (row) => row.providerId,
      );
      expect(providerIds).toHaveLength(2);
      expect([...providerIds].sort()).toEqual([site.providerId, site.otherProviderId].sort());
    });

    it("refuses an ungranted assistant rather than returning an empty page", async () => {
      // The distinction that matters: an empty set may never be spelled the same
      // way as "no filter" (§4.3). A 200 with zero rows would be indistinguishable
      // from a quiet day.
      const site = await clinic("norange");
      const reka = await member(site, "norange-reka", "ASSISTANT");
      await bookingOn(site, site.providerId, "09");

      const list = await app.inject({
        method: "GET",
        url: `/v1/bookings?from=${MONDAY}&to=${MONDAY}`,
        headers: as(reka.cookie, site.tenantId),
      });

      expect(list.statusCode, list.body).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe("lifecycle", () => {
    it("takes effect the moment it is revoked, with no new session", async () => {
      const site = await clinic("revoke");
      const reka = await member(site, "revoke-reka", "ASSISTANT");
      await grant(site, site.providerId, reka.membershipId, ["BOOKINGS"]);
      const bookingId = await bookingOn(site, site.providerId, "09");

      const before = await app.inject({
        method: "GET",
        url: `/v1/bookings/${bookingId}`,
        headers: as(reka.cookie, site.tenantId),
      });
      expect(before.statusCode, before.body).toBe(200);

      const removed = await revoke(site, site.providerId, reka.membershipId);
      expect(removed.statusCode, removed.body).toBe(204);

      const after = await app.inject({
        method: "GET",
        url: `/v1/bookings/${bookingId}`,
        headers: as(reka.cookie, site.tenantId),
      });
      expect(after.statusCode, after.body).toBe(403);

      // Hard delete, not a flag (§2.7).
      const rows = await app.prisma.providerDelegation.count({
        where: { tenantId: site.tenantId, membershipId: reka.membershipId },
      });
      expect(rows).toBe(0);

      const again = await revoke(site, site.providerId, reka.membershipId);
      expect(again.statusCode, again.body).toBe(404);
    });

    it("re-scopes rather than creating a second row", async () => {
      const site = await clinic("rescope");
      const reka = await member(site, "rescope-reka", "ASSISTANT");

      const first = await grant(site, site.providerId, reka.membershipId, ["BOOKINGS"]);
      expect(first.statusCode, first.body).toBe(200);

      const second = await grant(site, site.providerId, reka.membershipId, [
        "AVAILABILITY",
        "BOOKINGS",
      ]);
      expect(second.statusCode, second.body).toBe(200);
      expect((second.json().scopes as string[]).sort()).toEqual(["AVAILABILITY", "BOOKINGS"]);

      const rows = await app.prisma.providerDelegation.findMany({
        where: { tenantId: site.tenantId, providerId: site.providerId },
      });
      expect(rows).toHaveLength(1);

      const actions = await app.prisma.auditLog.findMany({
        where: { tenantId: site.tenantId, entityType: "ProviderDelegation" },
        orderBy: { createdAt: "asc" },
        select: { action: true, afterJson: true },
      });
      // Two actions rather than one, so "when did this person first get this
      // diary" stays a single grep (§5.3).
      expect(actions.map((row) => row.action)).toEqual([
        "delegation.granted",
        "delegation.rescoped",
      ]);
      // Ids only — never the target's name or email (rule 6).
      expect(JSON.stringify(actions)).not.toContain(reka.email);
    });

    it("survives a suspension and comes back with it", async () => {
      const site = await clinic("suspend");
      const reka = await member(site, "suspend-reka", "ASSISTANT");
      await grant(site, site.providerId, reka.membershipId, ["BOOKINGS"]);
      const bookingId = await bookingOn(site, site.providerId, "09");

      await app.prisma.membership.update({
        where: { id: reka.membershipId },
        data: { status: "SUSPENDED" },
      });

      const whileSuspended = await app.inject({
        method: "GET",
        url: `/v1/bookings/${bookingId}`,
        headers: as(reka.cookie, site.tenantId),
      });
      expect(whileSuspended.statusCode, whileSuspended.body).toBe(403);

      // The rows survived, so un-suspending restores the provider's
      // configuration rather than silently discarding it (§2.8).
      await app.prisma.membership.update({
        where: { id: reka.membershipId },
        data: { status: "ACTIVE" },
      });

      const restored = await app.inject({
        method: "GET",
        url: `/v1/bookings/${bookingId}`,
        headers: as(reka.cookie, site.tenantId),
      });
      expect(restored.statusCode, restored.body).toBe(200);
    });

    it("goes inert when the role stops receiving delegations", async () => {
      // Pins §2.8's decision: the rows are kept and confer nothing, rather than
      // being deleted. Reversing that should be a failing test.
      const site = await clinic("rolechange");
      const reka = await member(site, "rolechange-reka", "ASSISTANT");
      await grant(site, site.providerId, reka.membershipId, ["BOOKINGS"]);
      const bookingId = await bookingOn(site, site.providerId, "09");

      await app.prisma.membership.update({
        where: { id: reka.membershipId },
        data: { role: "PROVIDER" },
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/bookings/${bookingId}`,
        headers: as(reka.cookie, site.tenantId),
      });
      expect(response.statusCode, response.body).toBe(403);

      const rows = await app.prisma.providerDelegation.count({
        where: { tenantId: site.tenantId, membershipId: reka.membershipId },
      });
      expect(rows).toBe(1);
    });

    it("cascades away with the membership", async () => {
      const site = await clinic("cascade");
      const reka = await member(site, "cascade-reka", "ASSISTANT");
      await grant(site, site.providerId, reka.membershipId, ["BOOKINGS"]);

      await app.prisma.membership.delete({ where: { id: reka.membershipId } });

      const rows = await app.prisma.providerDelegation.count({
        where: { tenantId: site.tenantId, providerId: site.providerId },
      });
      expect(rows).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  describe("reads", () => {
    it("reports the caller's own grants, scoped to the tenant in the header", async () => {
      const site = await clinic("mine");
      const reka = await member(site, "mine-reka", "ASSISTANT");
      const eva = await member(site, "mine-eva", "ASSISTANT");

      await grant(site, site.providerId, reka.membershipId, ["AVAILABILITY"]);
      await grant(site, site.otherProviderId, eva.membershipId, ["BOOKINGS"]);

      const mine = await app.inject({
        method: "GET",
        url: "/v1/me/delegations",
        headers: as(reka.cookie, site.tenantId),
      });

      expect(mine.statusCode, mine.body).toBe(200);
      const items = mine.json().items as {
        providerId: string;
        providerName: string;
        scopes: string[];
      }[];
      expect(items).toHaveLength(1);
      expect(items[0]!.providerId).toBe(site.providerId);
      expect(items[0]!.providerName).toBe("Dr. Kovács Anna");
      expect(items[0]!.scopes).toEqual(["AVAILABILITY"]);

      // And /v1/me agrees, since both read the same resolved actor.
      const me = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: as(reka.cookie, site.tenantId),
      });
      expect(me.json().delegations).toEqual([
        { providerId: site.providerId, scopes: ["AVAILABILITY"] },
      ]);
    });

    it("offers only eligible candidates, and marks the ones already granted", async () => {
      const site = await clinic("candidates");
      const reka = await member(site, "candidates-reka", "ASSISTANT");
      const admin = await member(site, "candidates-admin", "ADMIN");
      await grant(site, site.providerId, reka.membershipId, ["BOOKINGS"]);

      const response = await app.inject({
        method: "GET",
        url: `/v1/providers/${site.providerId}/delegations/candidates`,
        headers: as(site.owner.cookie, site.tenantId),
      });

      expect(response.statusCode, response.body).toBe(200);
      const items = response.json().items as {
        membershipId: string;
        alreadyDelegated: boolean;
      }[];

      // The owner and the admin hold `:all` and cannot receive a diary, so the
      // picker never offers "delegate to the owner" and then refuses it.
      expect(items.map((row) => row.membershipId)).toEqual([reka.membershipId]);
      expect(items.map((row) => row.membershipId)).not.toContain(admin.membershipId);
      expect(items[0]!.alreadyDelegated).toBe(true);
    });
  });
});
