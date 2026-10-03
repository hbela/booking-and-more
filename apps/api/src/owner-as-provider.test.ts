import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "@bam/config";
import { ErrorCodes } from "@bam/contracts";
import { buildApp, type AppInstance } from "./app.js";

/**
 * The owner as a provider, and providers at two organizations, through real
 * HTTP. docs/phase-9-owner-as-provider.md.
 *
 * Two halves. The first is a link the model always allowed and the product
 * refused: an owner entering their own address on the Providers screen had the
 * create rolled back (§2.2). The second is a rule with no constraint to lean
 * on, owner here and provider elsewhere (§2.4), so every path that can produce
 * the forbidden state is driven here in both directions.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];

/** Random and file-prefixed — see the note in catalogue.test.ts. */
const RUN = `oap${randomBytes(4).toString("hex")}`;

describe.skipIf(!databaseUrl)("owner as provider", () => {
  let app: AppInstance;

  beforeAll(async () => {
    const env = loadEnv({
      source: {
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        APP_BASE_URL: "http://localhost:3000",
        API_BASE_URL: "http://localhost:3001",
        DATABASE_URL: databaseUrl!,
        CUSTOMER_PII_ENCRYPTION_KEY: "11".repeat(32),
        CUSTOMER_PII_BLIND_INDEX_KEY: "22".repeat(32),
        LAUNCH_ACCESS_MODE: "public",
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

  function cookieFrom(setCookie: string | string[] | undefined): string {
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
    return cookies
      .map((entry) => entry.split(";")[0])
      .filter(Boolean)
      .join("; ");
  }

  async function signUp(label: string): Promise<{ cookie: string; email: string; id: string }> {
    const email = `${label}-${RUN}@example.test`;

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: { email, password: "correct-horse-battery-staple", name: label },
    });
    expect(response.statusCode, `sign-up failed: ${response.body}`).toBeLessThan(400);

    const user = await app.prisma.user.findUnique({ where: { email } });
    return { cookie: cookieFrom(response.headers["set-cookie"]), email, id: user!.id };
  }

  function as(cookie: string, tenantId?: string) {
    return { cookie, ...(tenantId === undefined ? {} : { "x-tenant-id": tenantId }) };
  }

  function createTenant(cookie: string, label: string) {
    return app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: as(cookie),
      payload: { name: label, slug: `${label}-${RUN}` },
    });
  }

  /** A signed-up owner and the organization they created. */
  async function clinic(label: string) {
    const owner = await signUp(label);
    const tenant = await createTenant(owner.cookie, label);
    expect(tenant.statusCode, tenant.body).toBe(201);

    const membership = await app.prisma.membership.findFirstOrThrow({
      where: { tenantId: tenant.json().id as string, userId: owner.id },
    });

    return { ...owner, tenantId: tenant.json().id as string, membershipId: membership.id };
  }

  function createProvider(site: { cookie: string; tenantId: string }, email: string) {
    return app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: as(site.cookie, site.tenantId),
      payload: { displayName: "Dr. Kovács Anna", email },
    });
  }

  /** The raw token from the outbox — the only place it exists besides the email. */
  async function invitationTokenFor(tenantId: string, providerId: string): Promise<string> {
    const event = await app.prisma.outboxEvent.findFirstOrThrow({
      where: { tenantId, aggregateId: providerId, eventType: "PROVIDER_INVITED" },
      orderBy: { createdAt: "desc" },
    });
    return (event.payload as { invitationToken: string }).invitationToken;
  }

  function accept(cookie: string, token: string) {
    return app.inject({
      method: "POST",
      url: "/v1/invitations/accept",
      headers: as(cookie),
      payload: { token },
    });
  }

  function patchMember(
    site: { cookie: string; tenantId: string },
    membershipId: string,
    body: { role?: string; providerId?: string | null },
  ) {
    return app.inject({
      method: "PATCH",
      url: `/v1/members/${membershipId}`,
      headers: as(site.cookie, site.tenantId),
      payload: body,
    });
  }

  /** A provider with no login yet, bypassing the automatic invitation. */
  function bareProvider(tenantId: string) {
    return app.prisma.provider.create({
      data: {
        tenantId,
        displayName: "Practice diary",
        email: `practice-${randomBytes(3).toString("hex")}-${RUN}@example.test`,
        timezone: "Europe/Budapest",
      },
    });
  }

  /** A provider at `site`, signed up through the invitation the create sends. */
  async function providerAt(site: { cookie: string; tenantId: string }, label: string) {
    const email = `${label}-${RUN}@example.test`;
    const created = await createProvider(site, email);
    expect(created.statusCode, created.body).toBe(201);
    const providerId = created.json().id as string;

    const registered = await app.inject({
      method: "POST",
      url: "/v1/invitations/accept-and-register",
      payload: {
        token: await invitationTokenFor(site.tenantId, providerId),
        name: label,
        password: "correct-horse-battery-staple",
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);

    const user = await app.prisma.user.findUniqueOrThrow({ where: { email } });
    return {
      email,
      id: user.id,
      providerId,
      cookie: cookieFrom(registered.headers["set-cookie"]),
    };
  }

  // -------------------------------------------------------------------------
  // §2.2 — the owner who treats patients
  // -------------------------------------------------------------------------

  describe("an owner who is also a provider", () => {
    it("links the owner when they create a provider with their own address", async () => {
      const site = await clinic("own-address");

      const response = await createProvider(site, site.email);

      expect(response.statusCode, response.body).toBe(201);
      expect(response.json().onboarding).toBe("LINKED");

      const membership = await app.prisma.membership.findUniqueOrThrow({
        where: { id: site.membershipId },
      });
      // Still the owner. The diary is a link, not a demotion (§2.1).
      expect(membership.role).toBe("OWNER");
      expect(membership.providerId).toBe(response.json().id);

      // Nobody is emailed a token for an account they already have.
      expect(
        await app.prisma.outboxEvent.count({
          where: { tenantId: site.tenantId, eventType: "PROVIDER_INVITED" },
        }),
      ).toBe(0);
      expect(await app.prisma.invitation.count({ where: { tenantId: site.tenantId } })).toBe(0);
    });

    it("tells the screen an invitation went out for anybody else", async () => {
      const site = await clinic("other-address");

      const response = await createProvider(site, `someone-else-${RUN}@example.test`);

      expect(response.statusCode, response.body).toBe(201);
      expect(response.json().onboarding).toBe("INVITED");
    });

    it("lets an owner claim an existing diary as their own", async () => {
      const site = await clinic("claim");
      const provider = await bareProvider(site.tenantId);

      const linked = await patchMember(site, site.membershipId, { providerId: provider.id });
      expect(linked.statusCode, linked.body).toBe(200);

      const me = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: as(site.cookie, site.tenantId),
      });
      expect(me.json().membership).toMatchObject({ role: "OWNER", providerId: provider.id });

      // And let it go again.
      const unlinked = await patchMember(site, site.membershipId, { providerId: null });
      expect(unlinked.statusCode, unlinked.body).toBe(200);
      expect(unlinked.json().providerId).toBeNull();
    });

    it("refuses to give an ASSISTANT a diary, which would authorise nothing", async () => {
      const site = await clinic("assistant-link");
      const assistant = await signUp("assistant-link-member");
      const membership = await app.prisma.membership.create({
        data: { tenantId: site.tenantId, userId: assistant.id, role: "ASSISTANT" },
      });
      const provider = await bareProvider(site.tenantId);

      const response = await patchMember(site, membership.id, { providerId: provider.id });

      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().error.details.field).toBe("providerId");
    });

    it("never demotes an owner who accepts a provider invitation into their own clinic", async () => {
      const site = await clinic("no-demotion");
      const provider = await bareProvider(site.tenantId);

      // Not reachable from any screen — both invite paths refuse an existing
      // member — so it is written directly. What is under test is that
      // acceptance holds the line on its own (§2.5).
      const token = randomBytes(32).toString("base64url");
      await app.prisma.invitation.create({
        data: {
          tenantId: site.tenantId,
          email: site.email,
          role: "PROVIDER",
          providerId: provider.id,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          invitedByUserId: site.id,
        },
      });

      const response = await accept(site.cookie, token);
      expect(response.statusCode, response.body).toBe(200);

      const membership = await app.prisma.membership.findUniqueOrThrow({
        where: { id: site.membershipId },
      });
      expect(membership.role).toBe("OWNER");
      expect(membership.providerId).toBe(provider.id);
    });
  });

  // -------------------------------------------------------------------------
  // §2.4 — two organizations
  // -------------------------------------------------------------------------

  describe("a provider at two organizations", () => {
    it("lets one person be a provider at both", async () => {
      const first = await clinic("first-job");
      const second = await clinic("second-job");
      const dentist = await providerAt(first, "two-jobs");

      const created = await createProvider(second, dentist.email);
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().onboarding).toBe("INVITED");

      const accepted = await accept(
        dentist.cookie,
        await invitationTokenFor(second.tenantId, created.json().id as string),
      );
      expect(accepted.statusCode, accepted.body).toBe(200);

      const memberships = await app.prisma.membership.findMany({
        where: { userId: dentist.id },
        orderBy: { createdAt: "asc" },
      });
      expect(memberships.map((m) => [m.tenantId, m.role, m.providerId])).toEqual([
        [first.tenantId, "PROVIDER", dentist.providerId],
        [second.tenantId, "PROVIDER", created.json().id],
      ]);

      // Each organization sees only its own diary for them (rule 5).
      const tenants = await app.inject({
        method: "GET",
        url: "/v1/tenants",
        headers: as(dentist.cookie),
      });
      expect(tenants.json().items).toHaveLength(2);
    });
  });

  describe("owner here, provider elsewhere", () => {
    it("refuses an owner a provider invitation at another organization, and keeps it usable", async () => {
      const own = await clinic("owner-elsewhere");
      const other = await clinic("owner-elsewhere-b");

      const created = await createProvider(other, own.email);
      // Not refused at issue: that would tell this clinic what another
      // customer's address owns (§2.4).
      expect(created.statusCode, created.body).toBe(201);
      const token = await invitationTokenFor(other.tenantId, created.json().id as string);

      const response = await accept(own.cookie, token);

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe(ErrorCodes.MEMBERSHIP_ROLE_CONFLICT);
      expect(response.json().error.details.conflict).toBe("OWNER_ELSEWHERE");
      expect(
        await app.prisma.membership.count({ where: { tenantId: other.tenantId, userId: own.id } }),
      ).toBe(0);
      // Rolled back with everything else, so the inviter can still revoke it.
      expect(
        (await app.prisma.invitation.findFirstOrThrow({ where: { tenantId: other.tenantId } }))
          .status,
      ).toBe("PENDING");
    });

    it("refuses a provider elsewhere the creation of their own organization", async () => {
      const employer = await clinic("provider-founds");
      const dentist = await providerAt(employer, "provider-founds-dentist");

      const response = await createTenant(dentist.cookie, "provider-founds-own");

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.details.conflict).toBe("PROVIDER_ELSEWHERE");
      expect(await app.prisma.tenant.count({ where: { slug: `provider-founds-own-${RUN}` } })).toBe(
        0,
      );
    });

    it("refuses to promote a provider elsewhere to owner", async () => {
      const employer = await clinic("promote-a");
      const other = await clinic("promote-b");
      const dentist = await providerAt(employer, "promote-dentist");
      const admin = await app.prisma.membership.create({
        data: { tenantId: other.tenantId, userId: dentist.id, role: "ADMIN" },
      });

      const response = await patchMember(other, admin.id, { role: "OWNER" });

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.details.conflict).toBe("PROVIDER_ELSEWHERE");
      expect(
        (await app.prisma.membership.findUniqueOrThrow({ where: { id: admin.id } })).role,
      ).toBe("ADMIN");
    });

    it("refuses to give an owner elsewhere a diary as an ADMIN", async () => {
      const own = await clinic("admin-diary-a");
      const other = await clinic("admin-diary-b");
      const admin = await app.prisma.membership.create({
        data: { tenantId: other.tenantId, userId: own.id, role: "ADMIN" },
      });
      const provider = await bareProvider(other.tenantId);

      // An ADMIN with no diary is fine; one with a diary is a provider.
      const response = await patchMember(other, admin.id, { providerId: provider.id });

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.details.conflict).toBe("OWNER_ELSEWHERE");
    });

    it("refuses the link on provider creation as well, and rolls the provider back", async () => {
      const own = await clinic("create-link-a");
      const other = await clinic("create-link-b");
      await app.prisma.membership.create({
        data: { tenantId: other.tenantId, userId: own.id, role: "ADMIN" },
      });

      const response = await createProvider(other, own.email);

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe(ErrorCodes.MEMBERSHIP_ROLE_CONFLICT);
      expect(await app.prisma.provider.count({ where: { tenantId: other.tenantId } })).toBe(0);
    });

    it("still lets an owner of two clinics hold a diary in one of them", async () => {
      const first = await clinic("two-clinics");
      const second = await createTenant(first.cookie, "two-clinics-b");
      expect(second.statusCode, second.body).toBe(201);

      const response = await createProvider(
        { cookie: first.cookie, tenantId: second.json().id as string },
        first.email,
      );

      expect(response.statusCode, response.body).toBe(201);
      expect(response.json().onboarding).toBe("LINKED");
    });
  });
});
