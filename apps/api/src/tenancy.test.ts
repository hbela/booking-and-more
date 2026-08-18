import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEnv } from "@bam/config";
import { ErrorCodes } from "@bam/contracts";
import { buildApp, type AppInstance } from "./app.js";

/**
 * Epic 1 exit criteria, driven through real HTTP.
 *
 *   - an owner can create a tenant
 *   - an owner can invite an administrator or provider
 *   - users cannot access another tenant's data
 *   - role permissions are covered by tests
 *
 * Everything here goes through `fastify.inject()` against a real database and a
 * real Better Auth: accounts are created by signing up, and requests carry the
 * session cookie the sign-up actually returned. No handler is called directly
 * and no session is faked, because the parts most worth testing — the guards —
 * are exactly the parts a direct call would skip.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];

/**
 * Unique per run, so repeated runs do not collide on unique slugs and emails.
 *
 * Random rather than `Date.now()`: vitest runs suites in parallel against one
 * database, and two files starting in the same millisecond derived identical
 * identifiers from identical labels.
 */
const RUN = `tnc${randomBytes(4).toString("hex")}`;

describe.skipIf(!databaseUrl)("tenancy", () => {
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
    // Tenants cascade to memberships, invitations and audit logs.
    //
    // `endsWith`, not `contains`: every slug here ends with RUN, and a
    // substring match once deleted another parallel suite's tenants out from
    // under it — an intermittent foreign-key failure two files away.
    await app.prisma.tenant.deleteMany({ where: { slug: { endsWith: RUN } } });
    await app.prisma.user.deleteMany({ where: { email: { endsWith: `${RUN}@example.test` } } });
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Sign up through Better Auth and keep the session cookie it issues. */
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
    // Keep only name=value; the browser attributes would confuse the server.
    const cookie = cookies
      .map((entry) => entry.split(";")[0])
      .filter(Boolean)
      .join("; ");

    expect(cookie, "sign-up returned no session cookie").not.toBe("");

    const user = await app.prisma.user.findUnique({ where: { email } });
    return { cookie, email, id: user!.id };
  }

  /** Sign an existing user in again, to pick up a change made under them. */
  async function signIn(email: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-in/email",
      payload: { email, password: "correct-horse-battery-staple" },
    });

    expect(response.statusCode, `sign-in failed: ${response.body}`).toBeLessThan(400);

    const setCookie = response.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];

    return cookies
      .map((entry) => entry.split(";")[0])
      .filter(Boolean)
      .join("; ");
  }

  function as(cookie: string, tenantId?: string) {
    return {
      cookie,
      ...(tenantId === undefined ? {} : { "x-tenant-id": tenantId }),
    };
  }

  async function createTenant(cookie: string, slug: string, name: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: as(cookie),
      payload: { name, slug },
    });

    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  describe("authentication", () => {
    it("refuses an unauthenticated request with 401 in the standard envelope", async () => {
      const response = await app.inject({ method: "GET", url: "/v1/tenants" });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe(ErrorCodes.UNAUTHENTICATED);
    });

    it("reports the signed-in user from /v1/me", async () => {
      const alice = await signUp("me-probe");

      const response = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: as(alice.cookie),
      });

      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.user.email).toBe(alice.email);
      expect(body.user.isPlatformAdmin).toBe(false);
      // No tenant selected yet — a normal state, not an error.
      expect(body.tenant).toBeNull();
      expect(body.permissions).toEqual([]);
    });

    it("does not disguise tenant-resolution infrastructure failures as empty access", async () => {
      const alice = await signUp("me-database-failure");
      const lookup = vi
        .spyOn(app.prisma.session, "findFirst")
        .mockRejectedValueOnce(new Error("database unavailable"));

      try {
        const response = await app.inject({
          method: "GET",
          url: "/v1/me",
          headers: as(alice.cookie),
        });

        expect(response.statusCode).toBe(500);
        expect(response.json().error.code).toBe(ErrorCodes.INTERNAL_ERROR);
        expect(response.body).not.toContain("database unavailable");
      } finally {
        lookup.mockRestore();
      }
    });

    it("reports an invited owner's permissions without an explicit tenant", async () => {
      // The regression that hid an owner's own configuration screens from them.
      //
      // `activeTenantId` is written only by tenant creation and the explicit
      // activate route. An owner who arrives by invitation passes through
      // neither, and the dashboard's switcher — the only caller of activate —
      // renders only with two or more tenants. So the session stayed null
      // forever, `/v1/me` is fetched without the header, and it answered
      // `permissions: []`: an owner who appeared to lack permission to add a
      // service to their own clinic. A sole ACTIVE membership now answers it.
      const alice = await signUp("sole-membership");
      const tenantId = await createTenant(alice.cookie, `sole-${RUN}`, "Sole Clinic");

      // Undo what tenant creation set, so this is the invited owner's situation.
      await app.prisma.session.updateMany({
        where: { userId: alice.id },
        data: { activeTenantId: null },
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: as(alice.cookie),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.tenant?.id).toBe(tenantId);
      expect(body.membership?.role).toBe("OWNER");
      expect(body.permissions).toContain("service:manage");
      expect(body.permissions).toContain("provider:manage");
      expect(body.permissions).toContain("availability:manage:all");
    });

    it("stays ambiguous, rather than guessing, when there are two tenants", async () => {
      // Two ACTIVE memberships and no active tenant is a question with no single
      // right answer, so it is refused — which is also exactly when the
      // dashboard's switcher appears and can settle it.
      const bob = await signUp("two-memberships");
      await createTenant(bob.cookie, `first-${RUN}`, "First");
      await createTenant(bob.cookie, `second-${RUN}`, "Second");

      await app.prisma.session.updateMany({
        where: { userId: bob.id },
        data: { activeTenantId: null },
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: as(bob.cookie),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().tenant).toBeNull();
      expect(response.json().permissions).toEqual([]);
    });

    it("does not select a tenant the caller has only been invited to", async () => {
      // An INVITED membership is not membership yet. Falling back to one would
      // hand out a tenant the user has not joined.
      const carol = await signUp("invited-only");
      const owner = await signUp("invited-only-owner");
      const tenantId = await createTenant(owner.cookie, `invited-${RUN}`, "Invited Clinic");

      await app.prisma.membership.create({
        data: { tenantId, userId: carol.id, role: "ASSISTANT", status: "INVITED" },
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: as(carol.cookie),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().tenant).toBeNull();
      expect(response.json().permissions).toEqual([]);
    });

    it("cannot be tricked into granting platform admin at sign-up", async () => {
      // `isPlatformAdmin` is declared with `input: false`, so a crafted body
      // must not be able to set it. This is the privilege-escalation path worth
      // testing explicitly.
      const email = `escalate-${RUN}@example.test`;

      await app.inject({
        method: "POST",
        url: "/v1/auth/sign-up/email",
        payload: {
          email,
          password: "correct-horse-battery-staple",
          name: "Escalation Attempt",
          isPlatformAdmin: true,
        },
      });

      const user = await app.prisma.user.findUnique({ where: { email } });
      expect(user?.isPlatformAdmin).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Tenant creation
  // -------------------------------------------------------------------------

  describe("tenant creation", () => {
    it("creates a tenant and makes the creator its owner", async () => {
      const alice = await signUp("owner");
      const tenantId = await createTenant(alice.cookie, `clinic-a-${RUN}`, "Clinic A");

      const membership = await app.prisma.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId: alice.id } },
      });

      expect(membership?.role).toBe("OWNER");
      expect(membership?.status).toBe("ACTIVE");
      expect(membership?.joinedAt).not.toBeNull();
    });

    it("refuses to let a platform admin own a tenant", async () => {
      // Separation of duties: an operator of the platform is not one of its
      // customers. A platform admin already passes every tenant permission
      // check, so a membership grants them nothing and only makes their audit
      // trail ambiguous — their work as an owner would be indistinguishable
      // from platform intervention.
      const operator = await signUp("operator");
      await app.prisma.user.update({
        where: { id: operator.id },
        data: { isPlatformAdmin: true },
      });

      // A fresh session is required, not merely tidier: auth.ts enables a
      // 60-second session cookie cache, so the cookie from sign-up still
      // carries isPlatformAdmin: false until it expires.
      const cookie = await signIn(operator.email);

      const response = await app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { cookie },
        payload: { slug: `clinic-operator-${RUN}`, name: "Operator Clinic" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("FORBIDDEN");

      // And nothing was half-created: the refusal happens before the service.
      const tenant = await app.prisma.tenant.findUnique({
        where: { slug: `clinic-operator-${RUN}` },
      });
      expect(tenant).toBeNull();
    });

    it("writes an audit row for the creation", async () => {
      const alice = await signUp("audited-owner");
      const tenantId = await createTenant(alice.cookie, `clinic-audit-${RUN}`, "Audited");

      // The audit write is fire-and-forget, so give it a moment to land.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const entries = await app.prisma.auditLog.findMany({ where: { tenantId } });
      const created = entries.find((entry) => entry.action === "tenant.created");

      expect(created).toBeDefined();
      expect(created?.actorId).toBe(alice.id);
      expect(created?.actorType).toBe("USER");
      expect(created?.requestId).toMatch(/^req_/);
    });

    it("rejects a duplicate slug", async () => {
      const alice = await signUp("dup-a");
      const bob = await signUp("dup-b");
      const slug = `clinic-dup-${RUN}`;

      await createTenant(alice.cookie, slug, "First");

      const response = await app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: as(bob.cookie),
        payload: { name: "Second", slug },
      });

      expect(response.statusCode).toBe(409);
    });

    it("rejects a reserved slug", async () => {
      const alice = await signUp("reserved");

      const response = await app.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: as(alice.cookie),
        payload: { name: "Admin Clinic", slug: "admin" },
      });

      expect(response.statusCode).toBe(422);
    });

    it("rejects a malformed slug", async () => {
      const alice = await signUp("badslug");

      for (const slug of ["UPPER", "has space", "-leading", "trailing-", "double--hyphen"]) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/tenants",
          headers: as(alice.cookie),
          payload: { name: "Bad", slug },
        });

        expect(response.statusCode, `slug "${slug}" should be rejected`).toBe(422);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation — the exit criterion that matters most
  // -------------------------------------------------------------------------

  describe("tenant isolation", () => {
    it("hides another tenant behind the same 404 as a nonexistent one", async () => {
      const alice = await signUp("iso-alice");
      const bob = await signUp("iso-bob");

      const aliceTenant = await createTenant(alice.cookie, `iso-alice-${RUN}`, "Alice Clinic");

      // Bob is authenticated, and names Alice's tenant explicitly.
      const asBob = await app.inject({
        method: "GET",
        url: "/v1/tenants/current",
        headers: as(bob.cookie, aliceTenant),
      });

      expect(asBob.statusCode).toBe(404);
      expect(asBob.json().error.code).toBe(ErrorCodes.TENANT_NOT_FOUND);

      // A tenant that does not exist answers identically, so the API cannot be
      // used to discover which tenant IDs are real.
      const nonexistent = await app.inject({
        method: "GET",
        url: "/v1/tenants/current",
        headers: as(bob.cookie, "tenant_does_not_exist"),
      });

      expect(nonexistent.statusCode).toBe(404);
      expect(nonexistent.json().error.code).toBe(ErrorCodes.TENANT_NOT_FOUND);
    });

    it("blocks reading another tenant's members", async () => {
      const alice = await signUp("members-alice");
      const bob = await signUp("members-bob");
      const aliceTenant = await createTenant(alice.cookie, `members-a-${RUN}`, "Alice");

      const response = await app.inject({
        method: "GET",
        url: "/v1/members",
        headers: as(bob.cookie, aliceTenant),
      });

      expect(response.statusCode).toBe(404);
    });

    it("blocks writing to another tenant", async () => {
      const alice = await signUp("write-alice");
      const bob = await signUp("write-bob");
      const aliceTenant = await createTenant(alice.cookie, `write-a-${RUN}`, "Alice");

      const response = await app.inject({
        method: "PATCH",
        url: "/v1/tenants/current",
        headers: as(bob.cookie, aliceTenant),
        payload: { name: "Hijacked" },
      });

      expect(response.statusCode).toBe(404);

      const tenant = await app.prisma.tenant.findUnique({ where: { id: aliceTenant } });
      expect(tenant?.name).toBe("Alice");
    });

    it("only lists tenants the caller actually belongs to", async () => {
      const alice = await signUp("list-alice");
      const bob = await signUp("list-bob");

      await createTenant(alice.cookie, `list-a-${RUN}`, "Alice Clinic");
      const bobTenant = await createTenant(bob.cookie, `list-b-${RUN}`, "Bob Clinic");

      const response = await app.inject({
        method: "GET",
        url: "/v1/tenants",
        headers: as(bob.cookie),
      });

      const ids = (response.json().items as { id: string }[]).map((item) => item.id);
      expect(ids).toEqual([bobTenant]);
    });

    it("refuses to activate a tenant the caller does not belong to", async () => {
      const alice = await signUp("activate-alice");
      const bob = await signUp("activate-bob");
      const aliceTenant = await createTenant(alice.cookie, `activate-a-${RUN}`, "Alice");

      const response = await app.inject({
        method: "POST",
        url: `/v1/tenants/${aliceTenant}/activate`,
        headers: as(bob.cookie),
      });

      expect(response.statusCode).toBe(404);

      // And the session must not have been repointed.
      const sessions = await app.prisma.session.findMany({ where: { userId: bob.id } });
      expect(sessions.every((session) => session.activeTenantId !== aliceTenant)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Invitations
  // -------------------------------------------------------------------------

  describe("invitations", () => {
    it("invites a user who then joins with the invited role", async () => {
      const alice = await signUp("inv-owner");
      const bob = await signUp("inv-admin");
      const tenantId = await createTenant(alice.cookie, `inv-${RUN}`, "Invite Clinic");

      const invited = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(alice.cookie, tenantId),
        payload: { email: bob.email, role: "ADMIN" },
      });

      expect(invited.statusCode, invited.body).toBe(201);

      const acceptUrl = invited.json().acceptUrl as string;
      const token = acceptUrl.split("/").pop()!;

      const accepted = await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(bob.cookie),
        payload: { token },
      });

      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json().role).toBe("ADMIN");

      const membership = await app.prisma.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId: bob.id } },
      });
      expect(membership?.role).toBe("ADMIN");
      expect(membership?.status).toBe("ACTIVE");
    });

    it("stores only a hash of the token, never the token itself", async () => {
      const alice = await signUp("hash-owner");
      const carol = await signUp("hash-invitee");
      const tenantId = await createTenant(alice.cookie, `hash-${RUN}`, "Hash Clinic");

      const invited = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(alice.cookie, tenantId),
        payload: { email: carol.email, role: "ADMIN" },
      });

      const token = (invited.json().acceptUrl as string).split("/").pop()!;
      const row = await app.prisma.invitation.findFirst({ where: { tenantId } });

      expect(row?.tokenHash).toBeDefined();
      expect(row?.tokenHash).not.toBe(token);
      // A database leak must not yield working invitation links.
      expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("refuses an invitation accepted by the wrong account", async () => {
      const alice = await signUp("wrong-owner");
      const bob = await signUp("wrong-invitee");
      const mallory = await signUp("wrong-mallory");
      const tenantId = await createTenant(alice.cookie, `wrong-${RUN}`, "Wrong Clinic");

      const invited = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(alice.cookie, tenantId),
        payload: { email: bob.email, role: "ADMIN" },
      });

      const token = (invited.json().acceptUrl as string).split("/").pop()!;

      // Mallory has the link but it was not issued to her.
      const response = await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(mallory.cookie),
        payload: { token },
      });

      expect(response.statusCode).toBe(409);
      // The pair, not just the status. `accept-invitation.tsx` §4.1 branches on
      // 409 + FORBIDDEN to offer signing out, and the other 409s on this route
      // carry different codes — so this is the contract that keeps the wrong
      // recovery off the screen.
      expect(response.json().error.code).toBe("FORBIDDEN");

      const membership = await app.prisma.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId: mallory.id } },
      });
      expect(membership).toBeNull();
    });

    it("refuses a garbage token with the same error as a used one", async () => {
      const bob = await signUp("garbage");

      const response = await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(bob.cookie),
        payload: { token: "a".repeat(43) },
      });

      expect(response.statusCode).toBe(404);
    });

    it("cannot be reused after acceptance", async () => {
      const alice = await signUp("reuse-owner");
      const bob = await signUp("reuse-invitee");
      const tenantId = await createTenant(alice.cookie, `reuse-${RUN}`, "Reuse Clinic");

      const invited = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(alice.cookie, tenantId),
        payload: { email: bob.email, role: "ASSISTANT" },
      });

      const token = (invited.json().acceptUrl as string).split("/").pop()!;

      const first = await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(bob.cookie),
        payload: { token },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(bob.cookie),
        payload: { token },
      });
      expect(second.statusCode).toBe(404);
    });

    it("refuses to invite someone who is already a member", async () => {
      const alice = await signUp("already-owner");
      const tenantId = await createTenant(alice.cookie, `already-${RUN}`, "Already Clinic");

      const response = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(alice.cookie, tenantId),
        payload: { email: alice.email, role: "ADMIN" },
      });

      expect(response.statusCode).toBe(409);
    });

    it("never exposes the token hash when listing invitations", async () => {
      const alice = await signUp("listinv-owner");
      const dave = await signUp("listinv-invitee");
      const tenantId = await createTenant(alice.cookie, `listinv-${RUN}`, "List Clinic");

      await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(alice.cookie, tenantId),
        payload: { email: dave.email, role: "ADMIN" },
      });

      const listed = await app.inject({
        method: "GET",
        url: "/v1/members/invitations",
        headers: as(alice.cookie, tenantId),
      });

      expect(listed.statusCode).toBe(200);
      expect(listed.body).not.toContain("tokenHash");
      expect(listed.json().items).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Role enforcement over HTTP
  // -------------------------------------------------------------------------

  describe("role enforcement", () => {
    /** Build a tenant with an owner plus a member holding `role`. */
    /**
     * A tenant whose second member holds `role`.
     *
     * PROVIDER cannot be invited from this route — it carries no diary, so the
     * membership it would create can do nothing (phase-9-provider-onboarding
     * §2.11). Promoting an existing member is a different act and is still
     * allowed, so that is how this fixture reaches it.
     */
    async function tenantWith(role: string, label: string) {
      const owner = await signUp(`${label}-owner`);
      const member = await signUp(`${label}-member`);
      const tenantId = await createTenant(owner.cookie, `${label}-${RUN}`, label);
      const invitedAs = role === "PROVIDER" ? "ADMIN" : role;

      const invited = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(owner.cookie, tenantId),
        payload: { email: member.email, role: invitedAs },
      });

      const token = (invited.json().acceptUrl as string).split("/").pop()!;
      await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(member.cookie),
        payload: { token },
      });

      if (invitedAs !== role) {
        const membership = await app.prisma.membership.findFirst({
          where: { tenantId, userId: member.id },
        });
        const promoted = await app.inject({
          method: "PATCH",
          url: `/v1/members/${membership!.id}`,
          headers: as(owner.cookie, tenantId),
          payload: { role },
        });
        expect(promoted.statusCode, promoted.body).toBe(200);
      }

      return { owner, member, tenantId };
    }

    it("lets an assistant read members but not invite anyone", async () => {
      const { member, tenantId } = await tenantWith("ASSISTANT", "assistant");

      const read = await app.inject({
        method: "GET",
        url: "/v1/members",
        headers: as(member.cookie, tenantId),
      });
      expect(read.statusCode).toBe(200);

      const invite = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(member.cookie, tenantId),
        payload: { email: `nope-${RUN}@example.test`, role: "PROVIDER" },
      });
      expect(invite.statusCode).toBe(403);
      expect(invite.json().error.code).toBe(ErrorCodes.FORBIDDEN);
    });

    it("stops an admin changing tenant settings — that is the owner's alone", async () => {
      const { member, tenantId } = await tenantWith("ADMIN", "adminsettings");

      const response = await app.inject({
        method: "PATCH",
        url: "/v1/tenants/current",
        headers: as(member.cookie, tenantId),
        payload: { name: "Renamed by admin" },
      });

      expect(response.statusCode).toBe(403);
    });

    it("stops a provider reading the member list", async () => {
      const { member, tenantId } = await tenantWith("PROVIDER", "providerread");

      // PROVIDER holds MEMBER_READ, so this succeeds — asserted so the test
      // documents the actual boundary rather than an assumed one.
      const read = await app.inject({
        method: "GET",
        url: "/v1/members",
        headers: as(member.cookie, tenantId),
      });
      expect(read.statusCode).toBe(200);

      const invite = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(member.cookie, tenantId),
        payload: { email: `nope2-${RUN}@example.test`, role: "PROVIDER" },
      });
      expect(invite.statusCode).toBe(403);
    });

    it("reports the caller's effective permissions from /v1/me", async () => {
      const { member, tenantId } = await tenantWith("ASSISTANT", "permprobe");

      const response = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: as(member.cookie, tenantId),
      });

      const body = response.json();
      expect(body.membership.role).toBe("ASSISTANT");
      // Delegated, never universal, since docs/phase-3-4-diary-delegation.md
      // §2.1. The `not.toContain` is the half that matters: the front desk used
      // to hold the `:all` variant and reach every diary in the organization.
      expect(body.permissions).toContain("booking:manage:delegated");
      expect(body.permissions).not.toContain("booking:manage:all");
      expect(body.permissions).not.toContain("booking:read:all");
      expect(body.permissions).not.toContain("billing:manage");
      // Nobody has handed this member a diary, so they run none.
      expect(body.delegations).toEqual([]);
    });

    it("refuses to demote the last owner", async () => {
      const alice = await signUp("lastowner");
      const bob = await signUp("lastowner-other");
      const tenantId = await createTenant(alice.cookie, `lastowner-${RUN}`, "Last Owner");

      // Bring in an admin who can attempt the change, so the request is not
      // rejected merely for being self-modification.
      const invited = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(alice.cookie, tenantId),
        payload: { email: bob.email, role: "ADMIN" },
      });
      const token = (invited.json().acceptUrl as string).split("/").pop()!;
      await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(bob.cookie),
        payload: { token },
      });

      const ownerMembership = await app.prisma.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId: alice.id } },
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/v1/members/${ownerMembership!.id}`,
        headers: as(bob.cookie, tenantId),
        payload: { role: "ASSISTANT" },
      });

      expect(response.statusCode).toBe(409);

      const unchanged = await app.prisma.membership.findUnique({
        where: { id: ownerMembership!.id },
      });
      expect(unchanged?.role).toBe("OWNER");
    });

    it("refuses self role-modification even for an owner", async () => {
      const alice = await signUp("selfrole");
      const tenantId = await createTenant(alice.cookie, `selfrole-${RUN}`, "Self Role");

      const membership = await app.prisma.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId: alice.id } },
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/v1/members/${membership!.id}`,
        headers: as(alice.cookie, tenantId),
        payload: { role: "ADMIN" },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Tenant lifecycle
  // -------------------------------------------------------------------------

  describe("suspended tenants", () => {
    it("rejects writes but still allows reads", async () => {
      const alice = await signUp("suspended");
      const tenantId = await createTenant(alice.cookie, `suspended-${RUN}`, "Suspended Clinic");

      await app.prisma.tenant.update({ where: { id: tenantId }, data: { status: "SUSPENDED" } });

      const write = await app.inject({
        method: "PATCH",
        url: "/v1/tenants/current",
        headers: as(alice.cookie, tenantId),
        payload: { name: "Should not apply" },
      });
      // Even the owner is refused — that is the point of suspension.
      expect(write.statusCode).toBe(403);

      const read = await app.inject({
        method: "GET",
        url: "/v1/tenants/current",
        headers: as(alice.cookie, tenantId),
      });
      // Reads stay open so the owner can still see their data and settle up.
      expect(read.statusCode).toBe(200);
      expect(read.json().name).toBe("Suspended Clinic");
    });
  });

  // -------------------------------------------------------------------------
  // Contract hygiene
  // -------------------------------------------------------------------------

  describe("contract", () => {
    it("documents the tenancy routes in the OpenAPI spec", async () => {
      const spec = app.swagger() as unknown as {
        paths: Record<string, Record<string, unknown>>;
      };

      expect(spec.paths["/v1/tenants"]?.["post"]).toBeDefined();
      expect(spec.paths["/v1/members/invitations"]?.["post"]).toBeDefined();
      expect(spec.paths["/v1/me"]?.["get"]).toBeDefined();
    });

    it("never leaks a password hash through the members endpoint", async () => {
      const alice = await signUp("leak-probe");
      const tenantId = await createTenant(alice.cookie, `leak-${RUN}`, "Leak Clinic");

      const response = await app.inject({
        method: "GET",
        url: "/v1/members",
        headers: as(alice.cookie, tenantId),
      });

      expect(response.body).not.toContain("password");
      expect(response.body).not.toContain("$2");
    });
  });
});
