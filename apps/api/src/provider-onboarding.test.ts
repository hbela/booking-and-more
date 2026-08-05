import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "@bam/config";
import { ErrorCodes } from "@bam/contracts";
import { buildApp, type AppInstance } from "./app.js";

/**
 * Giving a provider a login, through real HTTP.
 * docs/phase-9-provider-onboarding.md.
 *
 * The thing under test is not "an email goes out" — that is the worker's. It is
 * that **the membership comes out linked to the diary**, in one step, and that
 * every way of failing to arrive there fails safely.
 *
 * The case the whole design turns on is "the diary was taken first" (§2.7): the
 * link is made inside the acceptance transaction, so a lost race must leave the
 * invitee with no membership *and* the invitation still PENDING, so an owner can
 * fix it without reissuing anything. That one is written first for a reason.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];

/** Random and file-prefixed — see the note in catalogue.test.ts. */
const RUN = `po${randomBytes(4).toString("hex")}`;

describe.skipIf(!databaseUrl)("provider onboarding", () => {
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

  /** An organization with one provider whose address nobody has used yet. */
  async function clinic(label: string) {
    const owner = await signUp(label);
    const slug = `${label}-${RUN}`;

    const tenant = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: as(owner.cookie),
      payload: { name: label, slug },
    });
    expect(tenant.statusCode, tenant.body).toBe(201);
    const tenantId = tenant.json().id as string;

    // Distinct per run *and* per clinic: the address is what the invitation
    // names, and a shared one would make two tests fight over one mailbox.
    const providerEmail = `${label}-diary-${RUN}@example.test`;

    const provider = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: as(owner.cookie, tenantId),
      payload: { displayName: "Dr. Kovács Anna", email: providerEmail },
    });
    expect(provider.statusCode, provider.body).toBe(201);

    return {
      ...owner,
      slug,
      tenantId,
      providerId: provider.json().id as string,
      providerEmail,
    };
  }

  function inviteProvider(site: { cookie: string; tenantId: string }, providerId: string) {
    return app.inject({
      method: "POST",
      url: `/v1/providers/${providerId}/invitation`,
      headers: as(site.cookie, site.tenantId),
    });
  }

  /** The raw token, which only ever exists in the response and the email. */
  function tokenFrom(response: { json: () => { acceptUrl: string } }): string {
    return response.json().acceptUrl.split("/").pop()!;
  }

  function acceptAndRegister(token: string, name: string) {
    return app.inject({
      method: "POST",
      url: "/v1/invitations/accept-and-register",
      payload: { token, name, password: "correct-horse-battery-staple" },
    });
  }

  async function membershipFor(tenantId: string, email: string) {
    return app.prisma.membership.findFirst({
      where: { tenantId, user: { email } },
    });
  }

  // -------------------------------------------------------------------------
  // The race the design turns on
  // -------------------------------------------------------------------------

  describe("when the diary is taken between invitation and acceptance", () => {
    it("refuses, creates no membership, and leaves the invitation usable", async () => {
      const site = await clinic("race");
      const invited = await inviteProvider(site, site.providerId);
      expect(invited.statusCode, invited.body).toBe(201);
      const token = tokenFrom(invited);

      // Somebody else is given the diary first. Invited as an ADMIN and then
      // linked by hand: the role is irrelevant to this race, because
      // `memberships_provider_id_key` is on `provider_id` alone — any membership
      // holding that diary blocks the next one. (It cannot be a PROVIDER
      // invitation any more; that route refuses the role for the reason tested
      // further down.)
      const rival = await signUp("race-rival");
      const rivalInvite = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(site.cookie, site.tenantId),
        payload: { email: rival.email, role: "ADMIN" },
      });
      await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(rival.cookie),
        payload: { token: tokenFrom(rivalInvite) },
      });
      const rivalMembership = await membershipFor(site.tenantId, rival.email);
      const linked = await app.inject({
        method: "PATCH",
        url: `/v1/members/${rivalMembership!.id}`,
        headers: as(site.cookie, site.tenantId),
        payload: { providerId: site.providerId },
      });
      expect(linked.statusCode, linked.body).toBe(200);

      const accepted = await acceptAndRegister(token, "Anna");

      expect(accepted.statusCode, accepted.body).toBe(409);
      // Not the uniform "this link is not valid": the token *was* valid, and
      // the constraint that failed says nothing about it (§2.7).
      expect(accepted.json().error.message).toMatch(/already been given/iu);

      // No half-joined member. The upsert and the invitation write are in the
      // transaction that rolled back.
      const orphan = await membershipFor(site.tenantId, `${site.providerEmail}`);
      expect(orphan).toBeNull();

      // The property a later refactor could quietly lose: unlink the rival and
      // this same link works, with no reissue.
      const invitation = await app.prisma.invitation.findFirst({
        where: { tenantId: site.tenantId, providerId: site.providerId },
      });
      expect(invitation?.status).toBe("PENDING");
    });

    it("refuses when the provider was archived in the meantime", async () => {
      const site = await clinic("archived-midflight");
      const token = tokenFrom(await inviteProvider(site, site.providerId));

      await app.inject({
        method: "DELETE",
        url: `/v1/providers/${site.providerId}`,
        headers: as(site.cookie, site.tenantId),
      });

      const accepted = await acceptAndRegister(token, "Anna");

      // Linking to an archived diary would produce `:own` permissions over a
      // row every query excludes — a role that does nothing, silently.
      expect(accepted.statusCode, accepted.body).toBe(409);
      expect(accepted.json().error.message).toMatch(/no longer active/iu);

      const invitation = await app.prisma.invitation.findFirst({
        where: { tenantId: site.tenantId, providerId: site.providerId },
      });
      expect(invitation?.status).toBe("PENDING");
    });
  });

  // -------------------------------------------------------------------------
  // The happy path
  // -------------------------------------------------------------------------

  describe("inviting", () => {
    it("issues an invitation carrying the diary, and an outbox event with the token", async () => {
      const site = await clinic("happy");

      const response = await inviteProvider(site, site.providerId);

      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({
        email: site.providerEmail,
        role: "PROVIDER",
        providerId: site.providerId,
      });

      const invitations = await app.prisma.invitation.findMany({
        where: { tenantId: site.tenantId },
      });
      expect(invitations).toHaveLength(1);
      expect(invitations[0]).toMatchObject({
        providerId: site.providerId,
        role: "PROVIDER",
        status: "PENDING",
        email: site.providerEmail,
      });

      const events = await app.prisma.outboxEvent.findMany({
        where: { tenantId: site.tenantId, eventType: "PROVIDER_INVITED" },
      });
      expect(events).toHaveLength(1);
      // "Provider", not "Tenant": the dispatcher routes on this, and reading
      // aggregateId as a tenant id is the mistake that branch guards against.
      expect(events[0]!.aggregateType).toBe("Provider");
      expect(events[0]!.aggregateId).toBe(site.providerId);
      const payload = events[0]!.payload as { invitationToken?: string; providerName?: string };
      expect(payload.invitationToken).toBeTruthy();
      expect(payload.providerName).toBe("Dr. Kovács Anna");
    });

    it("stores only a hash of the token", async () => {
      const site = await clinic("hashed");
      const token = tokenFrom(await inviteProvider(site, site.providerId));

      const invitation = await app.prisma.invitation.findFirst({
        where: { tenantId: site.tenantId },
      });

      expect(invitation!.tokenHash).not.toBe(token);
      expect(invitation!.tokenHash).toHaveLength(64);
    });

    it("names the provider in the lookup, so the invitee can spot a wrong link", async () => {
      const site = await clinic("lookup");
      const token = tokenFrom(await inviteProvider(site, site.providerId));

      const response = await app.inject({
        method: "POST",
        url: "/v1/invitations/lookup",
        payload: { token },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        role: "PROVIDER",
        providerName: "Dr. Kovács Anna",
        email: site.providerEmail,
        requiresRegistration: true,
      });
    });

    it("returns a locale-prefixed accept URL for an English organization", async () => {
      const site = await clinic("locale");
      await app.prisma.tenant.update({
        where: { id: site.tenantId },
        data: { defaultLanguage: "en" },
      });

      const response = await inviteProvider(site, site.providerId);

      // An unprefixed path *is* the Hungarian URL, so this is not cosmetic.
      expect(response.json().acceptUrl).toContain("/en/invitations/");
    });
  });

  describe("accepting", () => {
    it("creates an account whose membership already names the diary", async () => {
      const site = await clinic("accept");
      const token = tokenFrom(await inviteProvider(site, site.providerId));

      const accepted = await acceptAndRegister(token, "Anna");

      expect(accepted.statusCode, accepted.body).toBe(201);
      expect(accepted.json()).toMatchObject({ tenantId: site.tenantId, role: "PROVIDER" });

      const membership = await membershipFor(site.tenantId, site.providerEmail);
      // The whole point: no second step, no PATCH, no other screen.
      expect(membership).toMatchObject({
        role: "PROVIDER",
        status: "ACTIVE",
        providerId: site.providerId,
      });

      const invitation = await app.prisma.invitation.findFirst({
        where: { tenantId: site.tenantId },
      });
      expect(invitation?.status).toBe("ACCEPTED");
    });

    it("gives them a diary they can actually edit, and nobody else's", async () => {
      const site = await clinic("permissions");
      const token = tokenFrom(await inviteProvider(site, site.providerId));
      await acceptAndRegister(token, "Anna");

      // A fresh session rather than the sign-up cookie: this is the state the
      // real invitee is in after following the link.
      const signIn = await app.inject({
        method: "POST",
        url: "/v1/auth/sign-in/email",
        payload: { email: site.providerEmail, password: "correct-horse-battery-staple" },
      });
      const setCookie = signIn.headers["set-cookie"];
      const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ""])
        .map((entry) => entry.split(";")[0])
        .filter(Boolean)
        .join("; ");

      const hours = {
        workingHours: [{ weekday: 1, startTime: "09:00", endTime: "17:00" }],
      };

      const own = await app.inject({
        method: "PUT",
        url: `/v1/providers/${site.providerId}/working-hours`,
        headers: as(cookie, site.tenantId),
        payload: hours,
      });
      expect(own.statusCode, own.body).toBe(200);

      // `availability:manage:own` is scoped to the diary the membership names,
      // not to "any provider in a tenant I belong to".
      const other = await app.inject({
        method: "POST",
        url: "/v1/providers",
        headers: as(site.cookie, site.tenantId),
        payload: { displayName: "Dr. Nagy Béla", email: `nagy-${RUN}@example.test` },
      });

      const trespass = await app.inject({
        method: "PUT",
        url: `/v1/providers/${other.json().id}/working-hours`,
        headers: as(cookie, site.tenantId),
        payload: hours,
      });
      expect(trespass.statusCode, trespass.body).toBe(403);
    });

    it("never clears an existing link when a plain invitation is accepted", async () => {
      const site = await clinic("no-unlink");
      const token = tokenFrom(await inviteProvider(site, site.providerId));
      await acceptAndRegister(token, "Anna");

      const signIn = await app.inject({
        method: "POST",
        url: "/v1/auth/sign-in/email",
        payload: { email: site.providerEmail, password: "correct-horse-battery-staple" },
      });
      const setCookie = signIn.headers["set-cookie"];
      const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ""])
        .map((entry) => entry.split(";")[0])
        .filter(Boolean)
        .join("; ");

      // The same person invited into a *second* organization as an ADMIN. The
      // upsert must not treat "this invitation names no diary" as "unlink".
      const other = await clinic("no-unlink-other");
      const generic = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(other.cookie, other.tenantId),
        payload: { email: site.providerEmail, role: "ADMIN" },
      });
      const accepted = await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(cookie),
        payload: { token: tokenFrom(generic) },
      });
      expect(accepted.statusCode, accepted.body).toBe(200);

      const membership = await membershipFor(site.tenantId, site.providerEmail);
      expect(membership?.providerId).toBe(site.providerId);
    });
  });

  // -------------------------------------------------------------------------
  // Refusals
  // -------------------------------------------------------------------------

  describe("refusals", () => {
    it("answers 404 for a provider in another tenant", async () => {
      const mine = await clinic("iso-mine");
      const theirs = await clinic("iso-theirs");

      const response = await inviteProvider(mine, theirs.providerId);

      // The same answer as "no such provider" — a tenant the caller cannot see
      // must not be distinguishable from one that does not exist (rule 5).
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json().error.code).toBe(ErrorCodes.PROVIDER_NOT_FOUND);
    });

    it("answers 404 when the caller claims another tenant in the header", async () => {
      const mine = await clinic("iso-header");
      const theirs = await clinic("iso-header-other");

      const response = await app.inject({
        method: "POST",
        url: `/v1/providers/${theirs.providerId}/invitation`,
        headers: as(mine.cookie, theirs.tenantId),
      });

      expect(response.statusCode).toBe(404);
    });

    it("answers 404 for an archived provider", async () => {
      const site = await clinic("archived");
      await app.inject({
        method: "DELETE",
        url: `/v1/providers/${site.providerId}`,
        headers: as(site.cookie, site.tenantId),
      });

      const response = await inviteProvider(site, site.providerId);

      expect(response.statusCode, response.body).toBe(404);
    });

    it("refuses a provider with no email address, pointing at the fix", async () => {
      const site = await clinic("no-email");

      // Written directly: the API has refused a null address since phase-2-3
      // §2.8, so this is the legacy row the column's nullability still allows.
      const legacy = await app.prisma.provider.create({
        data: { tenantId: site.tenantId, displayName: "Visiting hygienist", timezone: "Europe/Budapest" },
      });

      const response = await inviteProvider(site, legacy.id);

      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().error.code).toBe(ErrorCodes.VALIDATION_FAILED);
      expect(response.json().error.details).toMatchObject({ field: "email" });
    });

    it("refuses when the diary already has a login", async () => {
      const site = await clinic("taken");
      const token = tokenFrom(await inviteProvider(site, site.providerId));
      await acceptAndRegister(token, "Anna");

      const again = await inviteProvider(site, site.providerId);

      expect(again.statusCode, again.body).toBe(409);
      expect(again.json().error.message).toMatch(/already has a login/iu);
    });

    it("refuses when the address is already a member, and says what to do instead", async () => {
      const site = await clinic("already-member");

      // The provider's own address, joined as an ADMIN first.
      const generic = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(site.cookie, site.tenantId),
        payload: { email: site.providerEmail, role: "ADMIN" },
      });
      await acceptAndRegister(tokenFrom(generic), "Anna");

      const response = await inviteProvider(site, site.providerId);

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.message).toMatch(/already a member/iu);
    });

    it("refuses a caller without member:manage", async () => {
      const site = await clinic("assistant");
      const assistant = await signUp("assistant-member");

      const invited = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(site.cookie, site.tenantId),
        payload: { email: assistant.email, role: "ASSISTANT" },
      });
      await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(assistant.cookie),
        payload: { token: tokenFrom(invited) },
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/providers/${site.providerId}/invitation`,
        headers: as(assistant.cookie, site.tenantId),
      });

      expect(response.statusCode, response.body).toBe(403);
    });

    it("refuses a PROVIDER invitation from the generic members route", async () => {
      // The trap this feature exists to close, reachable a second way until
      // 2026-08-04: that route has no diary to attach, so accepting produced a
      // membership whose every `:own` permission matched nothing — a person who
      // has joined, cannot act, and is told nothing. Found by an owner walking
      // §M, not by a test, which is why there is now a test.
      const site = await clinic("generic-provider");
      const someone = await signUp("generic-provider-person");

      const response = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(site.cookie, site.tenantId),
        payload: { email: someone.email, role: "PROVIDER" },
      });

      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().error.details).toMatchObject({ field: "role" });
      // The message has to name where it *can* be done, or it only blocks.
      expect(response.json().error.message).toMatch(/Providers screen/iu);

      expect(
        await app.prisma.invitation.count({ where: { tenantId: site.tenantId, role: "PROVIDER" } }),
      ).toBe(0);
    });

    it("still invites the other roles from the generic route", async () => {
      // The refusal above is scoped to PROVIDER, not a ban on the route.
      const site = await clinic("generic-admin");
      const someone = await signUp("generic-admin-person");

      const response = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(site.cookie, site.tenantId),
        payload: { email: someone.email, role: "ADMIN" },
      });

      expect(response.statusCode, response.body).toBe(201);
    });

    it("refuses while the organization is waiting to subscribe", async () => {
      const site = await clinic("pending");
      await app.prisma.tenant.update({
        where: { id: site.tenantId },
        data: { status: "PENDING_SUBSCRIPTION" },
      });

      const response = await inviteProvider(site, site.providerId);

      expect(response.statusCode, response.body).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Re-inviting
  // -------------------------------------------------------------------------

  describe("re-inviting", () => {
    it("supersedes the previous link rather than refusing", async () => {
      const site = await clinic("resend");
      const first = tokenFrom(await inviteProvider(site, site.providerId));

      const second = await inviteProvider(site, site.providerId);
      expect(second.statusCode, second.body).toBe(201);

      const stale = await app.inject({
        method: "POST",
        url: "/v1/invitations/lookup",
        payload: { token: first },
      });
      expect(stale.statusCode).toBe(404);

      const fresh = await app.inject({
        method: "POST",
        url: "/v1/invitations/lookup",
        payload: { token: tokenFrom(second) },
      });
      expect(fresh.statusCode, fresh.body).toBe(200);

      // One live invitation, which is what invitations_provider_pending_key
      // enforces and what the supersede exists to keep true.
      const live = await app.prisma.invitation.count({
        where: { providerId: site.providerId, status: "PENDING" },
      });
      expect(live).toBe(1);
    });

    it("supersedes across a corrected address", async () => {
      const site = await clinic("corrected");
      await inviteProvider(site, site.providerId);

      // The address was wrong; the owner fixes the record and re-invites. The
      // *new* address is free, but the old one's live invitation still points
      // at this diary — which the partial index would refuse.
      const corrected = `corrected-diary-${RUN}@example.test`;
      const patched = await app.inject({
        method: "PATCH",
        url: `/v1/providers/${site.providerId}`,
        headers: as(site.cookie, site.tenantId),
        payload: { email: corrected },
      });
      expect(patched.statusCode, patched.body).toBe(200);

      const response = await inviteProvider(site, site.providerId);

      expect(response.statusCode, response.body).toBe(201);
      expect(response.json().email).toBe(corrected);

      const live = await app.prisma.invitation.findMany({
        where: { providerId: site.providerId, status: "PENDING" },
      });
      expect(live).toHaveLength(1);
      expect(live[0]!.email).toBe(corrected);
    });

    it("emits a second outbox event, because a resend means the first did not arrive", async () => {
      const site = await clinic("resend-outbox");
      await inviteProvider(site, site.providerId);
      await inviteProvider(site, site.providerId);

      const events = await app.prisma.outboxEvent.count({
        where: { tenantId: site.tenantId, eventType: "PROVIDER_INVITED" },
      });
      expect(events).toBe(2);
    });
  });
});
