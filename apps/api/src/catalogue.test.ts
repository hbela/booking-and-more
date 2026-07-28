import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "@bam/config";
import { ErrorCodes } from "@bam/contracts";
import { buildApp, type AppInstance } from "./app.js";

/**
 * Epic 2 exit criteria, driven through real HTTP.
 *
 *   - an owner can fully configure one clinic
 *   - inactive services and providers cannot be publicly booked
 *
 * Same rules as tenancy.test.ts: real database, real Better Auth, real guards.
 * Nothing calls a handler directly, because the guards are the part most worth
 * testing and a direct call would skip them.
 *
 * The second criterion gets the most attention here. "Inactive" turns out to
 * have five distinct spellings — inactive service, inactive provider, archived
 * either, online booking switched off, and no assignment linking the two — and
 * each is a separate way for an unfinished catalogue to leak onto the internet.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];

/**
 * Unique per run, so repeated runs do not collide on unique slugs and emails.
 *
 * Random rather than `Date.now()`, and cleanup below matches on `endsWith`
 * rather than `contains`. Both matter, and both were learned the hard way:
 * vitest runs suites in parallel against one database, so two files starting in
 * the same millisecond derived the same identifier — and even once this file's
 * was prefixed, `contains` still matched it from the *other* suite's teardown,
 * which deleted these tenants mid-test. The next insert then failed on
 * `services_tenant_id_fkey`, roughly one run in three, and looked like a bug in
 * the service layer.
 */
const RUN = `cat${randomBytes(4).toString("hex")}`;

describe.skipIf(!databaseUrl)("catalogue", () => {
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
    // Tenants cascade to providers, services, locations and both join tables.
    // `endsWith`, so this suite can only ever delete rows it created.
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

  async function createTenant(cookie: string, slug: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: as(cookie),
      payload: { name: slug, slug },
    });

    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  /** An owner with a tenant, which is where every catalogue test starts. */
  async function owned(label: string): Promise<{ cookie: string; id: string; tenantId: string }> {
    const owner = await signUp(label);
    const tenantId = await createTenant(owner.cookie, `${label}-${RUN}`);
    return { cookie: owner.cookie, id: owner.id, tenantId };
  }

  async function createProvider(
    cookie: string,
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: as(cookie, tenantId),
      payload,
    });

    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  async function createService(
    cookie: string,
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/services",
      headers: as(cookie, tenantId),
      payload,
    });

    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  async function createLocation(
    cookie: string,
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/locations",
      headers: as(cookie, tenantId),
      payload,
    });

    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  async function assignServices(
    cookie: string,
    tenantId: string,
    providerId: string,
    services: Record<string, unknown>[],
  ) {
    return app.inject({
      method: "PUT",
      url: `/v1/providers/${providerId}/services`,
      headers: as(cookie, tenantId),
      payload: { services },
    });
  }

  /**
   * A tenant configured end to end: one provider, one service, one location,
   * everything assigned. The state Epic 2's first exit criterion describes.
   */
  async function configuredClinic(label: string) {
    const owner = await owned(label);
    const slug = `${label}-${RUN}`;

    const providerId = await createProvider(owner.cookie, owner.tenantId, {
      displayName: "Dr. Kovács Anna",
      email: "anna@example.test",
      languages: ["hu", "en"],
    });

    const serviceId = await createService(owner.cookie, owner.tenantId, {
      name: "Fogkő-eltávolítás",
      durationMinutes: 45,
      priceMinor: 1_500_000,
      currency: "HUF",
      translations: [{ locale: "en", name: "Scale and polish" }],
    });

    const locationId = await createLocation(owner.cookie, owner.tenantId, {
      name: "Main surgery",
      type: "PHYSICAL",
      addressLine1: "Váci út 1",
      city: "Budapest",
      countryCode: "hu",
    });

    const assigned = await assignServices(owner.cookie, owner.tenantId, providerId, [
      { serviceId },
    ]);
    expect(assigned.statusCode, assigned.body).toBe(200);

    const located = await app.inject({
      method: "PUT",
      url: `/v1/providers/${providerId}/locations`,
      headers: as(owner.cookie, owner.tenantId),
      payload: { locations: [{ locationId }] },
    });
    expect(located.statusCode, located.body).toBe(200);

    return { ...owner, slug, providerId, serviceId, locationId };
  }

  // -------------------------------------------------------------------------
  // Exit criterion 1: an owner can fully configure one clinic
  // -------------------------------------------------------------------------

  describe("configuring a clinic", () => {
    it("creates a provider, a service and a location, and links them", async () => {
      const clinic = await configuredClinic("configure");

      const services = await app.inject({
        method: "GET",
        url: `/v1/providers/${clinic.providerId}/services`,
        headers: as(clinic.cookie, clinic.tenantId),
      });

      expect(services.statusCode).toBe(200);
      expect(services.json().items).toEqual([
        expect.objectContaining({
          serviceId: clinic.serviceId,
          serviceActive: true,
          durationMinutes: 45,
          active: true,
        }),
      ]);

      const locations = await app.inject({
        method: "GET",
        url: `/v1/providers/${clinic.providerId}/locations`,
        headers: as(clinic.cookie, clinic.tenantId),
      });

      expect(locations.json().items).toEqual([
        expect.objectContaining({ locationId: clinic.locationId, active: true }),
      ]);
    });

    it("inherits the tenant's timezone rather than leaving it null", async () => {
      const owner = await owned("tz-inherit");

      const providerId = await createProvider(owner.cookie, owner.tenantId, {
        displayName: "Zone Inheritor",
      });

      const provider = await app.prisma.provider.findUnique({ where: { id: providerId } });
      expect(provider?.timezone).toBe("Europe/Budapest");

      // And an explicit zone still wins.
      const explicitId = await createProvider(owner.cookie, owner.tenantId, {
        displayName: "Zone Setter",
        timezone: "Europe/Vienna",
      });

      const explicit = await app.prisma.provider.findUnique({ where: { id: explicitId } });
      expect(explicit?.timezone).toBe("Europe/Vienna");
    });

    it("derives a service slug from the name, accents and all", async () => {
      const owner = await owned("slug-derive");

      const serviceId = await createService(owner.cookie, owner.tenantId, {
        name: "Fogkő-eltávolítás",
        durationMinutes: 30,
      });

      const service = await app.prisma.service.findUnique({ where: { id: serviceId } });
      expect(service?.slug).toBe("fogko-eltavolitas");
    });

    it("refuses a second service with the same slug", async () => {
      const owner = await owned("slug-clash");

      await createService(owner.cookie, owner.tenantId, {
        name: "Consultation",
        durationMinutes: 30,
      });

      const clash = await app.inject({
        method: "POST",
        url: "/v1/services",
        headers: as(owner.cookie, owner.tenantId),
        payload: { name: "Consultation", durationMinutes: 60 },
      });

      expect(clash.statusCode).toBe(409);
      expect(clash.json().error.code).toBe(ErrorCodes.SLUG_TAKEN);
    });

    it("refuses a price without a currency, and a physical location without a street", async () => {
      const owner = await owned("validation");

      const priced = await app.inject({
        method: "POST",
        url: "/v1/services",
        headers: as(owner.cookie, owner.tenantId),
        payload: { name: "Priced", durationMinutes: 30, priceMinor: 5000 },
      });

      expect(priced.statusCode).toBe(422);

      const homeless = await app.inject({
        method: "POST",
        url: "/v1/locations",
        headers: as(owner.cookie, owner.tenantId),
        payload: { name: "Nowhere", type: "PHYSICAL" },
      });

      expect(homeless.statusCode).toBe(422);

      // The same shape is fine once it is not a physical place.
      const online = await app.inject({
        method: "POST",
        url: "/v1/locations",
        headers: as(owner.cookie, owner.tenantId),
        payload: { name: "Video call", type: "ONLINE" },
      });

      expect(online.statusCode).toBe(201);
    });

    it("keeps the stored currency when a PATCH sets only the price", async () => {
      // The pairing rule spans request and row: a schema alone would reject
      // this, and rejecting it would be wrong.
      const owner = await owned("price-patch");

      const serviceId = await createService(owner.cookie, owner.tenantId, {
        name: "Repricing",
        durationMinutes: 30,
        priceMinor: 1000,
        currency: "HUF",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/v1/services/${serviceId}`,
        headers: as(owner.cookie, owner.tenantId),
        payload: { priceMinor: 2000 },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ priceMinor: 2000, currency: "HUF" });
    });

    it("archives rather than deletes", async () => {
      const clinic = await configuredClinic("archive");

      const archived = await app.inject({
        method: "DELETE",
        url: `/v1/services/${clinic.serviceId}`,
        headers: as(clinic.cookie, clinic.tenantId),
      });

      expect(archived.statusCode).toBe(204);

      // The row survives, so a booking taken last month still knows what it was
      // for — but it is out of the default list.
      const row = await app.prisma.service.findUnique({ where: { id: clinic.serviceId } });
      expect(row).not.toBeNull();
      expect(row?.archivedAt).not.toBeNull();
      expect(row?.active).toBe(false);

      const listed = await app.inject({
        method: "GET",
        url: "/v1/services",
        headers: as(clinic.cookie, clinic.tenantId),
      });

      expect(listed.json().items).toEqual([]);

      const withArchived = await app.inject({
        method: "GET",
        url: "/v1/services?includeArchived=true",
        headers: as(clinic.cookie, clinic.tenantId),
      });

      expect(withArchived.json().items).toHaveLength(1);
    });

    it("paginates by cursor, without repeating or losing a row", async () => {
      const owner = await owned("paging");

      for (const name of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) {
        await createService(owner.cookie, owner.tenantId, { name, durationMinutes: 30 });
      }

      const seen: string[] = [];
      let cursor: string | null = null;

      do {
        const query = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
        const page = await app.inject({
          method: "GET",
          url: `/v1/services?limit=2${query}`,
          headers: as(owner.cookie, owner.tenantId),
        });

        expect(page.statusCode, page.body).toBe(200);
        const body: { items: { name: string }[]; nextCursor: string | null } = page.json();

        seen.push(...body.items.map((item) => item.name));
        cursor = body.nextCursor;
      } while (cursor !== null);

      expect(seen).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
    });

    it("rejects a cursor it did not issue with a 422, not a 500", async () => {
      const owner = await owned("bad-cursor");

      const response = await app.inject({
        method: "GET",
        url: "/v1/services?cursor=not-a-real-cursor",
        headers: as(owner.cookie, owner.tenantId),
      });

      expect(response.statusCode).toBe(422);
    });

    it("audits catalogue writes", async () => {
      const owner = await owned("audited-catalogue");
      const providerId = await createProvider(owner.cookie, owner.tenantId, {
        displayName: "Audited Provider",
      });

      // The audit write is fire-and-forget, so give it a moment to land.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const entry = await app.prisma.auditLog.findFirst({
        where: { tenantId: owner.tenantId, action: "provider.created", entityId: providerId },
      });

      expect(entry).not.toBeNull();
      expect(entry?.actorId).toBe(owner.id);
    });
  });

  // -------------------------------------------------------------------------
  // Provider ↔ membership link
  // -------------------------------------------------------------------------

  describe("linking a member to a provider", () => {
    it("gives the member the provider scope the :own permissions match on", async () => {
      const clinic = await configuredClinic("link");

      const membership = await app.prisma.membership.findFirst({
        where: { tenantId: clinic.tenantId, userId: clinic.id },
      });

      const linked = await app.inject({
        method: "PATCH",
        url: `/v1/members/${membership!.id}`,
        headers: as(clinic.cookie, clinic.tenantId),
        payload: { providerId: clinic.providerId },
      });

      expect(linked.statusCode, linked.body).toBe(200);
      expect(linked.json().providerId).toBe(clinic.providerId);

      const me = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: as(clinic.cookie, clinic.tenantId),
      });

      expect(me.json().membership.providerId).toBe(clinic.providerId);
    });

    it("refuses a provider from another tenant", async () => {
      const mine = await owned("link-mine");
      const theirs = await configuredClinic("link-theirs");

      const membership = await app.prisma.membership.findFirst({
        where: { tenantId: mine.tenantId, userId: mine.id },
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/v1/members/${membership!.id}`,
        headers: as(mine.cookie, mine.tenantId),
        payload: { providerId: theirs.providerId },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe(ErrorCodes.PROVIDER_NOT_FOUND);
    });

    it("refuses to point two logins at the same diary", async () => {
      const clinic = await configuredClinic("link-twice");
      const second = await signUp("link-second");

      const invited = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(clinic.cookie, clinic.tenantId),
        payload: { email: second.email, role: "PROVIDER" },
      });

      const token = (invited.json().acceptUrl as string).split("/").pop()!;
      await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(second.cookie),
        payload: { token },
      });

      const ownerMembership = await app.prisma.membership.findFirst({
        where: { tenantId: clinic.tenantId, userId: clinic.id },
      });
      const secondMembership = await app.prisma.membership.findFirst({
        where: { tenantId: clinic.tenantId, userId: second.id },
      });

      const first = await app.inject({
        method: "PATCH",
        url: `/v1/members/${ownerMembership!.id}`,
        headers: as(clinic.cookie, clinic.tenantId),
        payload: { providerId: clinic.providerId },
      });
      expect(first.statusCode).toBe(200);

      const clash = await app.inject({
        method: "PATCH",
        url: `/v1/members/${secondMembership!.id}`,
        headers: as(clinic.cookie, clinic.tenantId),
        payload: { providerId: clinic.providerId },
      });

      expect(clash.statusCode).toBe(409);
    });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  describe("tenant isolation", () => {
    it("hides another tenant's provider, service and location behind a 404", async () => {
      const theirs = await configuredClinic("iso-theirs");
      const mine = await owned("iso-mine");

      const cases = [
        [`/v1/providers/${theirs.providerId}`, ErrorCodes.PROVIDER_NOT_FOUND],
        [`/v1/services/${theirs.serviceId}`, ErrorCodes.SERVICE_NOT_FOUND],
        [`/v1/locations/${theirs.locationId}`, ErrorCodes.LOCATION_NOT_FOUND],
      ] as const;

      for (const [url, code] of cases) {
        const response = await app.inject({
          method: "GET",
          url,
          // Authenticated, in their own tenant, naming a resource that exists.
          headers: as(mine.cookie, mine.tenantId),
        });

        expect(response.statusCode, `${url} should 404`).toBe(404);
        expect(response.json().error.code).toBe(code);
      }
    });

    it("refuses to update another tenant's provider", async () => {
      const theirs = await configuredClinic("iso-update-theirs");
      const mine = await owned("iso-update-mine");

      const response = await app.inject({
        method: "PATCH",
        url: `/v1/providers/${theirs.providerId}`,
        headers: as(mine.cookie, mine.tenantId),
        payload: { displayName: "Hijacked" },
      });

      expect(response.statusCode).toBe(404);

      const untouched = await app.prisma.provider.findUnique({ where: { id: theirs.providerId } });
      expect(untouched?.displayName).toBe("Dr. Kovács Anna");
    });

    it("refuses to assign another tenant's service to my provider", async () => {
      const theirs = await configuredClinic("iso-assign-theirs");
      const mine = await owned("iso-assign-mine");

      const providerId = await createProvider(mine.cookie, mine.tenantId, {
        displayName: "My Provider",
      });

      const response = await assignServices(mine.cookie, mine.tenantId, providerId, [
        { serviceId: theirs.serviceId },
      ]);

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe(ErrorCodes.SERVICE_NOT_FOUND);

      // And nothing was written — the check happens before the transaction.
      const links = await app.prisma.providerService.findMany({ where: { providerId } });
      expect(links).toEqual([]);
    });

    it("lists only the caller's own tenant's providers", async () => {
      const theirs = await configuredClinic("iso-list-theirs");
      const mine = await owned("iso-list-mine");
      await createProvider(mine.cookie, mine.tenantId, { displayName: "Only Mine" });

      const response = await app.inject({
        method: "GET",
        url: "/v1/providers",
        headers: as(mine.cookie, mine.tenantId),
      });

      const names = (response.json().items as { displayName: string }[]).map(
        (item) => item.displayName,
      );

      expect(names).toEqual(["Only Mine"]);
      expect(names).not.toContain("Dr. Kovács Anna");
      expect(theirs.providerId).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  describe("permissions", () => {
    /** A tenant with an owner plus one member holding `role`. */
    async function tenantWith(role: string, label: string) {
      const owner = await owned(label);
      const member = await signUp(`${label}-member`);

      const invited = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(owner.cookie, owner.tenantId),
        payload: { email: member.email, role },
      });

      const token = (invited.json().acceptUrl as string).split("/").pop()!;
      await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(member.cookie),
        payload: { token },
      });

      return { owner, member };
    }

    it("lets an assistant read the catalogue but not change it", async () => {
      const { owner, member } = await tenantWith("ASSISTANT", "perm-assistant");
      await createProvider(owner.cookie, owner.tenantId, { displayName: "Readable" });

      const read = await app.inject({
        method: "GET",
        url: "/v1/providers",
        headers: as(member.cookie, owner.tenantId),
      });

      expect(read.statusCode).toBe(200);
      expect(read.json().items).toHaveLength(1);

      const write = await app.inject({
        method: "POST",
        url: "/v1/providers",
        headers: as(member.cookie, owner.tenantId),
        payload: { displayName: "Should not exist" },
      });

      expect(write.statusCode).toBe(403);
      expect(write.json().error.code).toBe(ErrorCodes.FORBIDDEN);
    });

    it("does not let a provider reconfigure the catalogue", async () => {
      // A provider manages their own schedule (Epic 3), not the clinic's
      // services — PROVIDER_MANAGE is an owner/admin permission.
      const { owner, member } = await tenantWith("PROVIDER", "perm-provider");

      const response = await app.inject({
        method: "POST",
        url: "/v1/services",
        headers: as(member.cookie, owner.tenantId),
        payload: { name: "Unauthorised", durationMinutes: 30 },
      });

      expect(response.statusCode).toBe(403);
    });

    it("refuses catalogue writes to a suspended tenant while reads still work", async () => {
      const clinic = await configuredClinic("suspended");

      await app.prisma.tenant.update({
        where: { id: clinic.tenantId },
        data: { status: "SUSPENDED" },
      });

      const write = await app.inject({
        method: "POST",
        url: "/v1/providers",
        headers: as(clinic.cookie, clinic.tenantId),
        payload: { displayName: "While suspended" },
      });

      expect(write.statusCode).toBe(403);

      const read = await app.inject({
        method: "GET",
        url: "/v1/providers",
        headers: as(clinic.cookie, clinic.tenantId),
      });

      expect(read.statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Exit criterion 2: inactive services and providers cannot be publicly booked
  // -------------------------------------------------------------------------

  describe("the public catalogue", () => {
    async function publicServices(slug: string, query = "") {
      const response = await app.inject({
        method: "GET",
        url: `/v1/public/tenants/${slug}/services${query}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().items as { id: string; name: string }[];
    }

    async function publicProviders(slug: string, query = "") {
      const response = await app.inject({
        method: "GET",
        url: `/v1/public/tenants/${slug}/providers${query}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().items as { id: string; displayName: string }[];
    }

    it("serves a fully configured clinic to a stranger, with no session at all", async () => {
      const clinic = await configuredClinic("public-happy");

      const tenant = await app.inject({
        method: "GET",
        url: `/v1/public/tenants/${clinic.slug}`,
      });

      expect(tenant.statusCode, tenant.body).toBe(200);
      expect(tenant.json()).toMatchObject({ slug: clinic.slug });
      expect(tenant.json().locations).toHaveLength(1);
      // hu is the tenant's own; en exists because a service was translated.
      expect(tenant.json().languages).toEqual(["en", "hu"]);

      expect(await publicServices(clinic.slug)).toEqual([
        expect.objectContaining({ id: clinic.serviceId }),
      ]);
      expect(await publicProviders(clinic.slug)).toEqual([
        expect.objectContaining({ id: clinic.providerId }),
      ]);
    });

    it("returns the translated name for the requested locale, falling back per field", async () => {
      const clinic = await configuredClinic("public-i18n");

      const [hungarian] = await publicServices(clinic.slug);
      expect(hungarian?.name).toBe("Fogkő-eltávolítás");

      const [english] = await publicServices(clinic.slug, "?locale=en");
      expect(english?.name).toBe("Scale and polish");

      // The English translation has no description, so that field falls back to
      // the service's own rather than dragging the name back with it.
      const detail = await app.inject({
        method: "GET",
        url: `/v1/public/tenants/${clinic.slug}/services/${clinic.serviceId}?locale=en`,
      });

      expect(detail.json()).toMatchObject({ name: "Scale and polish", description: null });
    });

    it("hides an inactive service", async () => {
      const clinic = await configuredClinic("public-inactive-service");

      await app.inject({
        method: "PATCH",
        url: `/v1/services/${clinic.serviceId}`,
        headers: as(clinic.cookie, clinic.tenantId),
        payload: { active: false },
      });

      expect(await publicServices(clinic.slug)).toEqual([]);

      // And by id, not merely absent from the list.
      const detail = await app.inject({
        method: "GET",
        url: `/v1/public/tenants/${clinic.slug}/services/${clinic.serviceId}`,
      });

      expect(detail.statusCode).toBe(404);
      expect(detail.json().error.code).toBe(ErrorCodes.SERVICE_NOT_FOUND);
    });

    it("hides an inactive provider, and the services only they offered", async () => {
      const clinic = await configuredClinic("public-inactive-provider");

      await app.inject({
        method: "PATCH",
        url: `/v1/providers/${clinic.providerId}`,
        headers: as(clinic.cookie, clinic.tenantId),
        payload: { active: false },
      });

      expect(await publicProviders(clinic.slug)).toEqual([]);
      // The service is still active, but nobody bookable performs it.
      expect(await publicServices(clinic.slug)).toEqual([]);

      const detail = await app.inject({
        method: "GET",
        url: `/v1/public/tenants/${clinic.slug}/providers/${clinic.providerId}`,
      });

      expect(detail.statusCode).toBe(404);
      expect(detail.json().error.code).toBe(ErrorCodes.PROVIDER_NOT_FOUND);
    });

    it("hides a provider who has online booking switched off", async () => {
      // Still bookable by staff over the phone — just not offered publicly.
      const clinic = await configuredClinic("public-offline");

      await app.inject({
        method: "PATCH",
        url: `/v1/providers/${clinic.providerId}`,
        headers: as(clinic.cookie, clinic.tenantId),
        payload: { onlineBookingEnabled: false },
      });

      expect(await publicProviders(clinic.slug)).toEqual([]);

      // Staff still see them.
      const staff = await app.inject({
        method: "GET",
        url: "/v1/providers",
        headers: as(clinic.cookie, clinic.tenantId),
      });

      expect(staff.json().items).toHaveLength(1);
    });

    it("hides an archived provider and an archived service", async () => {
      const clinic = await configuredClinic("public-archived");

      await app.inject({
        method: "DELETE",
        url: `/v1/providers/${clinic.providerId}`,
        headers: as(clinic.cookie, clinic.tenantId),
      });

      expect(await publicProviders(clinic.slug)).toEqual([]);
      expect(await publicServices(clinic.slug)).toEqual([]);
    });

    it("hides a service nobody is assigned to", async () => {
      const clinic = await configuredClinic("public-unassigned");

      const orphan = await createService(clinic.cookie, clinic.tenantId, {
        name: "Nobody does this",
        durationMinutes: 30,
      });

      const listed = await publicServices(clinic.slug);
      expect(listed.map((item) => item.id)).toEqual([clinic.serviceId]);
      expect(listed.map((item) => item.id)).not.toContain(orphan);
    });

    it("hides a service whose only assignment has been deactivated", async () => {
      const clinic = await configuredClinic("public-assignment-off");

      const response = await assignServices(clinic.cookie, clinic.tenantId, clinic.providerId, [
        { serviceId: clinic.serviceId, active: false },
      ]);
      expect(response.statusCode).toBe(200);

      expect(await publicServices(clinic.slug)).toEqual([]);
      expect(await publicProviders(clinic.slug)).toEqual([]);
    });

    it("hides an inactive location", async () => {
      const clinic = await configuredClinic("public-location");

      await app.inject({
        method: "PATCH",
        url: `/v1/locations/${clinic.locationId}`,
        headers: as(clinic.cookie, clinic.tenantId),
        payload: { active: false },
      });

      const tenant = await app.inject({
        method: "GET",
        url: `/v1/public/tenants/${clinic.slug}`,
      });

      expect(tenant.json().locations).toEqual([]);
    });

    it("never publishes a provider's contact details", async () => {
      const clinic = await configuredClinic("public-pii");

      const [provider] = await publicProviders(clinic.slug);
      expect(provider).not.toHaveProperty("email");
      expect(provider).not.toHaveProperty("phone");
      expect(JSON.stringify(provider)).not.toContain("anna@example.test");
    });

    it("gives a suspended tenant the same 404 as a slug that never existed", async () => {
      const clinic = await configuredClinic("public-suspended");

      await app.prisma.tenant.update({
        where: { id: clinic.tenantId },
        data: { status: "SUSPENDED" },
      });

      const suspended = await app.inject({
        method: "GET",
        url: `/v1/public/tenants/${clinic.slug}`,
      });

      const nonexistent = await app.inject({
        method: "GET",
        url: `/v1/public/tenants/no-such-clinic-${RUN}`,
      });

      expect(suspended.statusCode).toBe(404);
      expect(nonexistent.statusCode).toBe(404);
      expect(suspended.json().error.code).toBe(nonexistent.json().error.code);
      expect(suspended.json().error.message).toBe(nonexistent.json().error.message);
    });

    it("filters providers by service and services by provider", async () => {
      const clinic = await configuredClinic("public-filter");

      const other = await createProvider(clinic.cookie, clinic.tenantId, {
        displayName: "Zoltán the Second",
      });
      const otherService = await createService(clinic.cookie, clinic.tenantId, {
        name: "Whitening",
        durationMinutes: 60,
      });
      await assignServices(clinic.cookie, clinic.tenantId, other, [{ serviceId: otherService }]);

      const forFirst = await publicServices(clinic.slug, `?providerId=${clinic.providerId}`);
      expect(forFirst.map((item) => item.id)).toEqual([clinic.serviceId]);

      const forService = await publicProviders(clinic.slug, `?serviceId=${otherService}`);
      expect(forService.map((item) => item.id)).toEqual([other]);
    });
  });
});
