import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "@bam/config";

import { buildApp, type AppInstance } from "./app.js";

/**
 * Platform administration. docs/phase-9-saas-administration.md.
 *
 * The two things worth asserting hardest are the ones a careless refactor would
 * break silently: that a non-admin cannot reach any of it, and that provisioning
 * does not make the platform admin a member of what they provisioned.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];

/** Unique per run: suites run in parallel against one database. */
const RUN = `plt${randomBytes(4).toString("hex")}`;

describe.skipIf(!databaseUrl)("platform administration", () => {
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
    await app.close();
  });

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

  async function signIn(email: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-in/email",
      payload: { email, password: "correct-horse-battery-staple" },
    });

    const setCookie = response.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];

    return cookies
      .map((entry) => entry.split(";")[0])
      .filter(Boolean)
      .join("; ");
  }

  /** A platform admin with a fresh session, since the flag is cached for 60s. */
  async function operator(label: string): Promise<{ cookie: string; id: string }> {
    const user = await signUp(label);
    await app.prisma.user.update({
      where: { id: user.id },
      data: { isPlatformAdmin: true },
    });
    return { cookie: await signIn(user.email), id: user.id };
  }

  const provision = (cookie: string, overrides: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/platform/organizations",
      headers: { cookie },
      payload: {
        name: "Wellness Studio",
        slug: `wellness-${RUN}`,
        domain: "wellness.hu",
        ownerName: "Kovács Anna",
        ownerEmail: `anna-${RUN}@example.test`,
        ...overrides,
      },
    });

  describe("authorization", () => {
    it("refuses an ordinary signed-in user", async () => {
      const alice = await signUp("plain");

      const response = await app.inject({
        method: "GET",
        url: "/v1/platform/organizations",
        headers: { cookie: alice.cookie },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("FORBIDDEN");
    });

    it("refuses an anonymous caller", async () => {
      const response = await app.inject({ method: "GET", url: "/v1/platform/organizations" });
      expect(response.statusCode).toBe(401);
    });

    it("refuses an ordinary user trying to provision", async () => {
      // The important one: reading the list is embarrassing, creating
      // organizations for free is the business model.
      const alice = await signUp("plain-provision");
      const response = await provision(alice.cookie, { slug: `sneaky-${RUN}` });

      expect(response.statusCode).toBe(403);
    });

    it("admits a platform admin", async () => {
      const admin = await operator("op-list");

      const response = await app.inject({
        method: "GET",
        url: "/v1/platform/organizations",
        headers: { cookie: admin.cookie },
      });

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json().items)).toBe(true);
    });
  });

  describe("provisioning", () => {
    it("creates a gated organization and an owner invitation", async () => {
      const admin = await operator("op-provision");
      const response = await provision(admin.cookie, {
        slug: `prov-${RUN}`,
        domain: `prov-${RUN}.hu`,
        ownerEmail: `owner-prov-${RUN}@example.test`,
      });

      expect(response.statusCode).toBe(201);

      const body = response.json();
      expect(body.organization.status).toBe("PENDING_SUBSCRIPTION");
      expect(body.organization.domain).toBe(`prov-${RUN}.hu`);
      expect(body.acceptUrl).toContain("/invitations/");

      // The owner is invited, not yet a member.
      expect(body.organization.owner.email).toBe(`owner-prov-${RUN}@example.test`);
      expect(body.organization.owner.accepted).toBe(false);
    });

    it("does not make the platform admin a member of what they provisioned", async () => {
      // CLAUDE.md rule 9. This is the whole reason provisioning is a separate
      // operation from POST /v1/tenants rather than a flag on it.
      const admin = await operator("op-nomember");
      const response = await provision(admin.cookie, {
        slug: `nomember-${RUN}`,
        domain: `nomember-${RUN}.hu`,
        ownerEmail: `owner-nomember-${RUN}@example.test`,
      });

      const tenantId = response.json().organization.id;
      const membership = await app.prisma.membership.findFirst({
        where: { tenantId, userId: admin.id },
      });

      expect(membership).toBeNull();
    });

    it("sets a subscription deadline for a prospect", async () => {
      const admin = await operator("op-deadline");
      const response = await provision(admin.cookie, {
        slug: `deadline-${RUN}`,
        domain: `deadline-${RUN}.hu`,
        ownerEmail: `owner-deadline-${RUN}@example.test`,
      });

      const body = response.json();
      expect(body.organization.subscribeBy).not.toBeNull();
      expect(body.organization.daysRemaining).toBeGreaterThan(0);
    });

    it("stores the raw token only as a hash", async () => {
      // tech-impl §34.4 — a database leak must not hand over usable links.
      const admin = await operator("op-hash");
      const response = await provision(admin.cookie, {
        slug: `hash-${RUN}`,
        domain: `hash-${RUN}.hu`,
        ownerEmail: `owner-hash-${RUN}@example.test`,
      });

      const acceptUrl = response.json().acceptUrl as string;
      const token = acceptUrl.split("/invitations/")[1]!;

      const stored = await app.prisma.invitation.findFirst({
        where: { tenantId: response.json().organization.id },
      });

      expect(stored?.tokenHash).toBeDefined();
      expect(stored?.tokenHash).not.toBe(token);
    });

    describe("internal mode", () => {
      it("creates an active organization with an INTERNAL subscription", async () => {
        // A demo organization must be usable immediately, so it is not gated —
        // and it carries a subscription row so quota lookups never find nothing.
        const admin = await operator("op-internal");
        const response = await provision(admin.cookie, {
          slug: `internal-${RUN}`,
          domain: `internal-${RUN}.hu`,
          ownerEmail: `owner-internal-${RUN}@example.test`,
          mode: "INTERNAL",
        });

        const body = response.json();
        expect(body.organization.status).toBe("ACTIVE");
        expect(body.organization.subscription.plan).toBe("INTERNAL");
      });

      it("gives an internal organization no deadline, so the sweep skips it", async () => {
        const admin = await operator("op-internal-nodeadline");
        const response = await provision(admin.cookie, {
          slug: `nodeadline-${RUN}`,
          domain: `nodeadline-${RUN}.hu`,
          ownerEmail: `owner-nodeadline-${RUN}@example.test`,
          mode: "INTERNAL",
        });

        expect(response.json().organization.subscribeBy).toBeNull();
        expect(response.json().organization.daysRemaining).toBeNull();
      });
    });
  });

  describe("the domain is the organization's identity", () => {
    it("refuses a second organization for the same domain", async () => {
      // Two salespeople working the same lead. One organization, one error —
      // not two half-configured tenants nobody notices until billing.
      const admin = await operator("op-dupe");
      const domain = `dupe-${RUN}.hu`;

      const first = await provision(admin.cookie, {
        slug: `dupe-a-${RUN}`,
        domain,
        ownerEmail: `owner-dupe-a-${RUN}@example.test`,
      });
      expect(first.statusCode).toBe(201);

      const second = await provision(admin.cookie, {
        slug: `dupe-b-${RUN}`,
        domain,
        ownerEmail: `owner-dupe-b-${RUN}@example.test`,
      });

      expect(second.statusCode).toBe(409);
      expect(second.json().error.details.field).toBe("domain");
    });

    it("treats www, scheme and casing as the same business", async () => {
      const admin = await operator("op-norm");

      const first = await provision(admin.cookie, {
        slug: `norm-a-${RUN}`,
        domain: `norm-${RUN}.hu`,
        ownerEmail: `owner-norm-a-${RUN}@example.test`,
      });
      expect(first.statusCode).toBe(201);

      const second = await provision(admin.cookie, {
        slug: `norm-b-${RUN}`,
        domain: `HTTPS://WWW.NORM-${RUN}.HU/`,
        ownerEmail: `owner-norm-b-${RUN}@example.test`,
      });

      expect(second.statusCode).toBe(409);
    });

    it("stores the normalized form", async () => {
      const admin = await operator("op-stored");
      const response = await provision(admin.cookie, {
        slug: `stored-${RUN}`,
        domain: `https://www.Stored-${RUN}.HU/pricing`,
        ownerEmail: `owner-stored-${RUN}@example.test`,
      });

      expect(response.json().organization.domain).toBe(`stored-${RUN}.hu`);
    });

    it("rejects something that is not a domain", async () => {
      const admin = await operator("op-baddomain");
      const response = await provision(admin.cookie, {
        slug: `baddomain-${RUN}`,
        domain: "not a domain",
        ownerEmail: `owner-baddomain-${RUN}@example.test`,
      });

      // 422, not 400: this codebase distinguishes a malformed request from a
      // well-formed one carrying an unacceptable value.
      expect(response.statusCode).toBe(422);
    });
  });

  describe("suspension", () => {
    it("suspends and reactivates", async () => {
      const admin = await operator("op-suspend");
      const created = await provision(admin.cookie, {
        slug: `suspend-${RUN}`,
        domain: `suspend-${RUN}.hu`,
        ownerEmail: `owner-suspend-${RUN}@example.test`,
        mode: "INTERNAL",
      });

      const id = created.json().organization.id;

      const suspended = await app.inject({
        method: "PATCH",
        url: `/v1/platform/organizations/${id}/status`,
        headers: { cookie: admin.cookie },
        payload: { status: "SUSPENDED" },
      });
      expect(suspended.statusCode).toBe(200);
      expect(suspended.json().status).toBe("SUSPENDED");

      const reactivated = await app.inject({
        method: "PATCH",
        url: `/v1/platform/organizations/${id}/status`,
        headers: { cookie: admin.cookie },
        payload: { status: "ACTIVE" },
      });
      expect(reactivated.json().status).toBe("ACTIVE");
    });

    it("returns a trialling organization to TRIAL, not ACTIVE", async () => {
      const admin = await operator("op-suspend-trial");
      const created = await provision(admin.cookie, {
        slug: `suspend-trial-${RUN}`,
        domain: `suspend-trial-${RUN}.hu`,
        ownerEmail: `owner-suspend-trial-${RUN}@example.test`,
      });
      const id = created.json().organization.id;

      // The state a real organization reaches once its checkout completes: the
      // Stripe events do this, so it is set up directly rather than replayed.
      await app.prisma.subscription.create({
        data: { tenantId: id, plan: "STARTER", status: "TRIALING" },
      });
      await app.prisma.tenant.update({ where: { id }, data: { status: "TRIAL" } });

      const setStatus = (status: string) =>
        app.inject({
          method: "PATCH",
          url: `/v1/platform/organizations/${id}/status`,
          headers: { cookie: admin.cookie },
          payload: { status },
        });

      expect((await setStatus("SUSPENDED")).json().status).toBe("SUSPENDED");

      // Not ACTIVE: the subscription still says TRIALING, and the two must not
      // disagree about the same customer.
      expect((await setStatus("ACTIVE")).json().status).toBe("TRIAL");
    });

    it("returns a prospect that never paid to PENDING_SUBSCRIPTION", async () => {
      // Reactivating used to hardcode ACTIVE, which produced an active
      // organization with no subscription row — the state phase-9 §2.2 forbids.
      const admin = await operator("op-suspend-pending");
      const created = await provision(admin.cookie, {
        slug: `suspend-pending-${RUN}`,
        domain: `suspend-pending-${RUN}.hu`,
        ownerEmail: `owner-suspend-pending-${RUN}@example.test`,
      });
      const id = created.json().organization.id;

      expect(created.json().organization.status).toBe("PENDING_SUBSCRIPTION");

      const setStatus = (status: string) =>
        app.inject({
          method: "PATCH",
          url: `/v1/platform/organizations/${id}/status`,
          headers: { cookie: admin.cookie },
          payload: { status },
        });

      expect((await setStatus("SUSPENDED")).json().status).toBe("SUSPENDED");

      const reactivated = await setStatus("ACTIVE");
      expect(reactivated.json().status).toBe("PENDING_SUBSCRIPTION");
      expect(reactivated.json().subscription).toBeNull();
    });

    it("will not set CLOSED through the status route", async () => {
      // Closing is heavier and has its own path; folding it in here would put
      // it one typo away from every suspension.
      const admin = await operator("op-close");
      const created = await provision(admin.cookie, {
        slug: `close-${RUN}`,
        domain: `close-${RUN}.hu`,
        ownerEmail: `owner-close-${RUN}@example.test`,
        mode: "INTERNAL",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/v1/platform/organizations/${created.json().organization.id}/status`,
        headers: { cookie: admin.cookie },
        payload: { status: "CLOSED" },
      });

      expect(response.statusCode).toBe(422);
    });
  });

  describe("resending the owner invitation", () => {
    it("issues a new link and revokes the old one", async () => {
      // The invitation expires in 168h but the organization has ~14 days, so a
      // lapsed link must be reissuable without a database fix.
      const admin = await operator("op-resend");
      const created = await provision(admin.cookie, {
        slug: `resend-${RUN}`,
        domain: `resend-${RUN}.hu`,
        ownerEmail: `owner-resend-${RUN}@example.test`,
      });

      const id = created.json().organization.id;
      const firstUrl = created.json().acceptUrl as string;

      const response = await app.inject({
        method: "POST",
        url: `/v1/platform/organizations/${id}/resend-invitation`,
        headers: { cookie: admin.cookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().acceptUrl).not.toBe(firstUrl);

      const live = await app.prisma.invitation.findMany({
        where: { tenantId: id, status: "PENDING" },
      });
      expect(live).toHaveLength(1);

      const revoked = await app.prisma.invitation.findMany({
        where: { tenantId: id, status: "REVOKED" },
      });
      expect(revoked).toHaveLength(1);
    });

    it("asks for the email to actually be sent", async () => {
      // The bug this exists for: reissuing produced a new link and no email.
      // The route returned 200, the operator saw success, and the owner got
      // nothing — on the one path people reach *because* they are stuck.
      const admin = await operator("op-resend-email");
      const created = await provision(admin.cookie, {
        slug: `resendmail-${RUN}`,
        domain: `resendmail-${RUN}.hu`,
        ownerEmail: `owner-resendmail-${RUN}@example.test`,
      });

      const id = created.json().organization.id;

      await app.inject({
        method: "POST",
        url: `/v1/platform/organizations/${id}/resend-invitation`,
        headers: { cookie: admin.cookie },
      });

      const events = await app.prisma.outboxEvent.findMany({
        where: { tenantId: id, aggregateType: "Tenant" },
        orderBy: { createdAt: "asc" },
      });

      // One from provisioning, one from the reissue. Each carries its own
      // token, and the notification dedupe key is the event id, so both send.
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.eventType === "ORGANIZATION_PROVISIONED")).toBe(true);

      const reissue = events[1]?.payload as { invitationToken?: string } | null;
      expect(reissue?.invitationToken).toBeTruthy();
      expect(reissue?.invitationToken).not.toBe(
        (events[0]?.payload as { invitationToken?: string } | null)?.invitationToken,
      );
    });
  });

  describe("search", () => {
    const find = (cookie: string, term: string) =>
      app.inject({
        method: "GET",
        url: `/v1/platform/organizations?search=${encodeURIComponent(term)}`,
        headers: { cookie },
      });

    const slugsIn = (response: Awaited<ReturnType<typeof find>>): string[] =>
      response.json<{ items: { slug: string }[] }>().items.map((entry) => entry.slug);

    it("finds an organization by the address its owner invitation went to", async () => {
      // The owner column shows this address before it is accepted, so an
      // operator chasing "who has not clicked the link" searches by it.
      const admin = await operator("op-search-invited");
      const slug = `search-invited-${RUN}`;
      await provision(admin.cookie, {
        slug,
        domain: `search-invited-${RUN}.hu`,
        ownerEmail: `findme-invited-${RUN}@example.test`,
      });

      expect(slugsIn(await find(admin.cookie, `findme-invited-${RUN}`))).toContain(slug);
    });

    it("finds an organization by its accepted owner's name and email", async () => {
      const admin = await operator("op-search-member");
      const slug = `search-member-${RUN}`;
      const created = await provision(admin.cookie, {
        slug,
        domain: `search-member-${RUN}.hu`,
        ownerEmail: `owner-member-${RUN}@example.test`,
      });

      // Accepting for real needs the emailed token; the membership is what the
      // search matches on, so it is created directly.
      const owner = await signUp("owner-member");
      await app.prisma.membership.create({
        data: {
          tenantId: created.json().organization.id,
          userId: owner.id,
          role: "OWNER",
          status: "ACTIVE",
        },
      });

      // Set apart from the address on purpose, so matching the name is not
      // satisfied by the email containing the same label.
      const displayName = `Zsóka${RUN}`;
      await app.prisma.user.update({ where: { id: owner.id }, data: { name: displayName } });

      expect(slugsIn(await find(admin.cookie, displayName))).toContain(slug);
      expect(slugsIn(await find(admin.cookie, owner.email))).toContain(slug);
    });

    it("does not match a member who is not the owner", async () => {
      // The column names the owner, so matching any member would return a row
      // whose owner is a stranger to the term that found it.
      const admin = await operator("op-search-staff");
      const created = await provision(admin.cookie, {
        slug: `search-staff-${RUN}`,
        domain: `search-staff-${RUN}.hu`,
        ownerEmail: `owner-staff-${RUN}@example.test`,
      });

      const assistant = await signUp("assistant-staff");
      await app.prisma.membership.create({
        data: {
          tenantId: created.json().organization.id,
          userId: assistant.id,
          role: "ASSISTANT",
          status: "ACTIVE",
        },
      });

      expect(slugsIn(await find(admin.cookie, assistant.email))).not.toContain(
        `search-staff-${RUN}`,
      );
    });

    it("matches slug and domain regardless of case", async () => {
      // `name` was insensitive and these two were not, so a domain typed with a
      // capital letter matched the name and missed the domain.
      const admin = await operator("op-search-case");
      const slug = `search-case-${RUN}`;
      await provision(admin.cookie, {
        slug,
        domain: `search-case-${RUN}.hu`,
        ownerEmail: `owner-case-${RUN}@example.test`,
      });

      expect(slugsIn(await find(admin.cookie, `SEARCH-CASE-${RUN}`.toUpperCase()))).toContain(slug);
      expect(slugsIn(await find(admin.cookie, `SEARCH-CASE-${RUN}.HU`))).toContain(slug);
    });
  });
});
