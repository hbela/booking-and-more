import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "@bam/config";

import { buildApp, type AppInstance } from "./app.js";

/**
 * Owner onboarding. docs/phase-9-owner-onboarding.md.
 *
 * The flow these cover is the one a real customer walks first: an emailed link,
 * a password, a dashboard. Before `accept-and-register` existed it took four
 * steps and one of them was undiscoverable, so the happy path here is the
 * feature.
 *
 * The test that matters most is not the happy path, though — it is
 * "registers only the invited address". That is the route's single security
 * property (§2.1), and it is the kind of thing a refactor that adds an `email`
 * field to the body would break while every other test stayed green.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];

/** Unique per run: suites run in parallel against one database. */
const RUN = `onb${randomBytes(4).toString("hex")}`;

const PASSWORD = "correct-horse-battery-staple";

describe.skipIf(!databaseUrl)("owner onboarding", () => {
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

  function cookiesFrom(headers: { "set-cookie"?: string | string[] | undefined }): string {
    const setCookie = headers["set-cookie"];
    const cookies: string[] = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];

    return cookies
      .map((entry) => entry.split(";")[0] ?? "")
      .filter(Boolean)
      .join("; ");
  }

  async function signUp(label: string): Promise<{ cookie: string; email: string; id: string }> {
    const email = `${label}-${RUN}@example.test`;

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: { email, password: PASSWORD, name: label },
    });

    expect(response.statusCode, `sign-up failed: ${response.body}`).toBeLessThan(400);

    const user = await app.prisma.user.findUnique({ where: { email } });
    return { cookie: cookiesFrom(response.headers), email, id: user!.id };
  }

  /** A platform admin with a fresh session, since the flag is cached for 60s. */
  async function operator(label: string): Promise<{ cookie: string }> {
    const user = await signUp(label);
    await app.prisma.user.update({
      where: { id: user.id },
      data: { isPlatformAdmin: true },
    });

    const signIn = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-in/email",
      payload: { email: user.email, password: PASSWORD },
    });

    return { cookie: cookiesFrom(signIn.headers) };
  }

  /**
   * Provision a prospect and hand back what the owner would have received.
   * The token is pulled out of the accept URL exactly as clicking the link does.
   */
  async function provisionFor(
    label: string,
  ): Promise<{ token: string; ownerEmail: string; tenantId: string }> {
    const admin = await operator(`op-${label}`);
    const ownerEmail = `owner-${label}-${RUN}@example.test`;

    const response = await app.inject({
      method: "POST",
      url: "/v1/platform/organizations",
      headers: { cookie: admin.cookie },
      payload: {
        name: "Wellness Studio",
        slug: `${label}-${RUN}`,
        domain: `${label}-${RUN}.hu`,
        ownerName: "Kovács Anna",
        ownerEmail,
      },
    });

    expect(response.statusCode, `provisioning failed: ${response.body}`).toBe(201);

    const body = response.json<{ acceptUrl: string; organization: { id: string } }>();
    const token = body.acceptUrl.split("/invitations/")[1] ?? "";

    expect(token, "no token in the accept URL").toBeTruthy();

    return { token, ownerEmail, tenantId: body.organization.id };
  }

  const lookup = (token: string) =>
    app.inject({ method: "POST", url: "/v1/invitations/lookup", payload: { token } });

  const acceptAndRegister = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/v1/invitations/accept-and-register", payload });

  describe("lookup", () => {
    it("describes the invitation to an anonymous caller", async () => {
      // Anonymous on purpose: the person holding this link has no account yet,
      // which is the entire reason the route exists.
      const { token, ownerEmail } = await provisionFor("look");

      const response = await lookup(token);

      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.organizationName).toBe("Wellness Studio");
      expect(body.email).toBe(ownerEmail);
      expect(body.role).toBe("OWNER");
      expect(body.requiresRegistration).toBe(true);
    });

    it("reports requiresRegistration false once the address has an account", async () => {
      const { token, ownerEmail } = await provisionFor("look-existing");
      await signUp(ownerEmail.split("@")[0]!.replace(`-${RUN}`, ""));

      // Sign up under the invited address directly, so the branch is about the
      // address rather than about who is signed in.
      await app.inject({
        method: "POST",
        url: "/v1/auth/sign-up/email",
        payload: { email: ownerEmail, password: PASSWORD, name: "Anna" },
      });

      expect((await lookup(token)).json().requiresRegistration).toBe(false);
    });

    it("gives the same answer for an unknown token as for a revoked one", async () => {
      const { token, tenantId } = await provisionFor("look-revoked");

      // Scoped to this tenant, for the same reason the user lookup two tests
      // down is scoped to one address: the suites share a database and vitest
      // runs their files in parallel. Unscoped, this revoked every PENDING
      // invitation in it — including one another file had just provisioned and
      // was about to accept, which failed there as an unexplained 404 from
      // `accept-and-register` on a token that had been valid moments earlier.
      await app.prisma.invitation.updateMany({
        where: { tenantId, status: "PENDING" },
        data: { status: "REVOKED" },
      });

      const revoked = await lookup(token);
      const unknown = await lookup(randomBytes(32).toString("base64url"));

      expect(revoked.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      // Identical, so a guess teaches nothing about which case it hit.
      expect(revoked.json().error.message).toBe(unknown.json().error.message);
    });
  });

  describe("accept-and-register", () => {
    it("creates the account, the membership and a session in one call", async () => {
      const { token, ownerEmail, tenantId } = await provisionFor("accept");

      const response = await acceptAndRegister({ token, name: "Kovács Anna", password: PASSWORD });

      expect(response.statusCode, response.body).toBe(201);
      expect(response.json().role).toBe("OWNER");
      expect(response.json().tenantId).toBe(tenantId);

      // A session came back, so the owner lands on the dashboard signed in
      // rather than at a sign-in form (§1).
      expect(cookiesFrom(response.headers)).toContain("bam");

      const user = await app.prisma.user.findUnique({ where: { email: ownerEmail } });
      expect(user).not.toBeNull();
      // The token only ever existed in that mailbox, so receiving it is the
      // same proof a verification email would have collected (§2.2).
      expect(user!.emailVerified).toBe(true);

      const membership = await app.prisma.membership.findFirst({
        where: { tenantId, userId: user!.id },
      });
      expect(membership?.role).toBe("OWNER");
      expect(membership?.status).toBe("ACTIVE");

      const invitation = await app.prisma.invitation.findFirst({ where: { tenantId } });
      expect(invitation?.status).toBe("ACCEPTED");
    });

    it("registers only the invited address, whatever the body claims", async () => {
      // The security property of the whole flow (§2.1). A leaked token is a
      // claim about one mailbox; it must never become a grant for another.
      const { token, ownerEmail, tenantId } = await provisionFor("hijack");
      const attacker = `attacker-${RUN}@example.test`;

      const response = await acceptAndRegister({
        token,
        name: "Someone Else",
        password: PASSWORD,
        email: attacker,
        ownerEmail: attacker,
      });

      expect(response.statusCode).toBe(201);

      // No account was created for the address the caller asked for...
      expect(await app.prisma.user.findUnique({ where: { email: attacker } })).toBeNull();

      // ...and the membership belongs to the invited address.
      const membership = await app.prisma.membership.findFirst({
        where: { tenantId },
        include: { user: { select: { email: true } } },
      });
      expect(membership?.user.email).toBe(ownerEmail);
    });

    it("refuses when the invited address already has an account", async () => {
      const { token, ownerEmail } = await provisionFor("taken");

      await app.inject({
        method: "POST",
        url: "/v1/auth/sign-up/email",
        payload: { email: ownerEmail, password: PASSWORD, name: "Anna" },
      });

      const response = await acceptAndRegister({ token, name: "Anna", password: PASSWORD });

      // 409 rather than 401: nothing is wrong with the link, they simply need
      // the other route. The web page turns this into a sign-in prompt.
      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toContain("Sign in");
    });

    it("refuses a password shorter than Better Auth accepts", async () => {
      const { token, ownerEmail } = await provisionFor("shortpw");

      const response = await acceptAndRegister({ token, name: "Anna", password: "short" });

      // 422, the project's validation status (ValidationError in @bam/contracts).
      // Refused by our schema rather than by Better Auth, so the message names
      // the field instead of surfacing a downstream provider error.
      expect(response.statusCode).toBe(422);
      // Scoped to this invitation's address: suites share a database, so a
      // lookup by name would match a user another test just created.
      expect(await app.prisma.user.findUnique({ where: { email: ownerEmail } })).toBeNull();
    });

    it("refuses an expired invitation and leaves no account behind", async () => {
      const { token, ownerEmail, tenantId } = await provisionFor("expired");

      await app.prisma.invitation.updateMany({
        where: { tenantId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const response = await acceptAndRegister({ token, name: "Anna", password: PASSWORD });

      expect(response.statusCode).toBe(404);
      // Validation happens before anything is created (§2.4), so a rejected
      // attempt does not leave an orphaned user behind.
      expect(await app.prisma.user.findUnique({ where: { email: ownerEmail } })).toBeNull();

      const invitation = await app.prisma.invitation.findFirst({ where: { tenantId } });
      expect(invitation?.status).toBe("EXPIRED");
    });

    it("cannot be used twice", async () => {
      const { token } = await provisionFor("replay");

      expect(
        (await acceptAndRegister({ token, name: "Anna", password: PASSWORD })).statusCode,
      ).toBe(201);

      const replay = await acceptAndRegister({ token, name: "Anna", password: PASSWORD });

      // The invitation is ACCEPTED, so it is no longer a valid token at all —
      // the same answer an unknown token gets.
      expect(replay.statusCode).toBe(404);
    });
  });

  describe("what the owner may do next", () => {
    it("lands in PENDING_SUBSCRIPTION and is refused writes", async () => {
      // The activation gate (phase-9 §2.4). Onboarding deliberately stops here:
      // the owner has an organization and cannot configure it until it is paid
      // for.
      const { token, tenantId } = await provisionFor("gated");

      const registered = await acceptAndRegister({
        token,
        name: "Kovács Anna",
        password: PASSWORD,
      });
      const cookie = cookiesFrom(registered.headers);

      const me = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { cookie, "x-tenant-id": tenantId },
      });

      expect(me.statusCode).toBe(200);
      expect(me.json().tenant.status).toBe("PENDING_SUBSCRIPTION");
      expect(me.json().membership.role).toBe("OWNER");

      const write = await app.inject({
        method: "POST",
        url: "/v1/services",
        headers: { cookie, "x-tenant-id": tenantId },
        payload: { name: "Consultation", durationMinutes: 30 },
      });

      expect(write.statusCode).toBe(403);
    });
  });
});
