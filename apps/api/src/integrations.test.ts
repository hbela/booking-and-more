import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "@bam/config";
import { ErrorCodes } from "@bam/contracts";
import { looksSealed, openToken, parseEncryptionKey } from "@bam/crypto";
import { GoogleApiError } from "@bam/google-calendar";
import type {
  GoogleCalendarClient,
  GoogleCalendarSummary,
  GoogleOAuthClient,
  GoogleTokenSet,
} from "@bam/google-calendar";

import { buildApp, type AppInstance } from "./app.js";
import { resetGoogleOAuthForTests } from "./modules/integrations/google.client.js";

/**
 * Connecting a Google account. docs/phase-6-google-calendar-part-1.md, step 5.
 *
 * Three properties are worth the file, and the rest is scaffolding around them:
 *
 *  1. **What lands in the database is sealed.** Asserted as
 *     `not.toContain(plaintext)` and then by opening it with the configured key,
 *     because "forgot to seal" is a one-character mistake that no type catches
 *     and that nothing else in the system would notice for months.
 *  2. **A handshake is single-use.** The state is burned by an `updateMany`
 *     guarded on `consumedAt`, so the replay test is really a test that
 *     PostgreSQL rather than application code decides (rule 14).
 *  3. **Nothing here is an open redirect.** Every failure path answers 302, and
 *     every `Location` is asserted to start with our own base URL — a callback
 *     that echoes a caller-supplied destination is the classic bug of this exact
 *     route shape.
 *
 * Google itself is replaced wholesale by {@link stubGoogleOAuth}; the wire
 * format is proved without a network in `@bam/google-calendar`.
 *
 * ## PARKED 2026-08-17 — Epic 6 part 1
 *
 * `integrationRoutes` is no longer registered in `app.ts`, so every request
 * below answers 404 — including the two that assert the 503 a deployment
 * without Google credentials should give, which is the distinction that
 * disappears when a module is unmounted rather than unconfigured.
 *
 * Skipped whole rather than rewritten to expect 404: the assertions are about
 * the module's behaviour, and re-pointing them at its absence would delete the
 * evidence that has to be re-earned when it comes back.
 */

const databaseUrl = process.env["TEST_DATABASE_URL"];
/** Un-park: drop this and restore `!databaseUrl` in the `skipIf` below. */
const parked = true;

const RUN = `itg${randomBytes(4).toString("hex")}`;
const PASSWORD = "correct-horse-battery-staple";
const APP_BASE_URL = "http://localhost:3000";

/** Fixed so the suite can open what the API sealed and prove it was this key. */
const ENCRYPTION_KEY = "0".repeat(32) + "f".repeat(32);

const REFRESH_TOKEN = "1//0gRefreshTokenThatMustNeverBeStoredInTheClear";
const ACCESS_TOKEN = "ya29.a0AccessTokenThatMustNeverBeStoredInTheClear";

const ALL_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
];

/**
 * Google's OAuth endpoints, under this suite's control.
 *
 * Mutable rather than constructed per test: `buildApp` runs once in `beforeAll`,
 * so the seam has to be reachable afterwards. Every test that cares sets what it
 * needs at the top, which also documents the case it is about.
 */
function stubGoogleOAuth() {
  const revoked: string[] = [];
  const exchanged: string[] = [];

  const next = {
    accountEmail: "anna.personal@gmail.com",
    refreshToken: REFRESH_TOKEN as string | undefined,
    scopes: [...ALL_SCOPES],
    failExchange: false,
    failRevoke: false,
    /** What a refresh returns. Null means "the same set an exchange would". */
    refreshed: null as GoogleTokenSet | null,
    /** Set to make a refresh fail with a Google-shaped error. */
    refreshError: null as { status: number; reason: string } | null,
  };

  const client: GoogleOAuthClient = {
    exchangeCode: (code: string): Promise<GoogleTokenSet> => {
      exchanged.push(code);
      if (next.failExchange) return Promise.reject(new Error("google said no"));

      return Promise.resolve({
        accessToken: ACCESS_TOKEN,
        refreshToken: next.refreshToken,
        expiresAt: new Date(Date.now() + 3_600_000),
        scopes: [...next.scopes],
      });
    },
    refresh: (): Promise<GoogleTokenSet> => {
      if (next.refreshError !== null) {
        return Promise.reject(
          new GoogleApiError("refresh failed", {
            status: next.refreshError.status,
            reason: next.refreshError.reason,
          }),
        );
      }

      return Promise.resolve(
        next.refreshed ?? {
          accessToken: ACCESS_TOKEN,
          // Google issues a refresh token once per grant, so a refresh response
          // never carries one. The default reflects that rather than a shortcut.
          refreshToken: undefined,
          expiresAt: new Date(Date.now() + 3_600_000),
          scopes: [...next.scopes],
        },
      );
    },
    fetchAccountEmail: () => Promise.resolve(next.accountEmail),
    revoke: (token: string) => {
      if (next.failRevoke) return Promise.reject(new Error("google said no"));
      revoked.push(token);
      return Promise.resolve();
    },
  };

  function reset(): void {
    next.accountEmail = "anna.personal@gmail.com";
    next.refreshToken = REFRESH_TOKEN;
    next.scopes = [...ALL_SCOPES];
    next.failExchange = false;
    next.failRevoke = false;
    next.refreshed = null;
    next.refreshError = null;
  }

  return { client, next, revoked, exchanged, reset };
}

/**
 * The Calendar API, likewise.
 *
 * Only `listCalendars` is exercised in the API — the event endpoints belong to
 * the worker (step 7) — but the whole interface is implemented so the stub
 * fails to compile the day one of them is called from here by mistake.
 */
function stubGoogleCalendar() {
  const listedWith: string[] = [];

  const next = {
    calendars: [
      {
        id: "anna@example.test",
        summary: "Anna",
        primary: true,
        accessRole: "owner",
        timeZone: "Europe/Budapest",
      },
      {
        id: "team@group.calendar.google.com",
        summary: "Team",
        primary: false,
        accessRole: "writer",
        timeZone: null,
      },
    ] as GoogleCalendarSummary[],
    failList: null as { status: number; reason: string } | null,
  };

  const client: GoogleCalendarClient = {
    listCalendars: (accessToken: string) => {
      listedWith.push(accessToken);
      if (next.failList !== null) {
        return Promise.reject(
          new GoogleApiError("listing failed", {
            status: next.failList.status,
            reason: next.failList.reason,
          }),
        );
      }
      return Promise.resolve([...next.calendars]);
    },
    insertEvent: () => Promise.reject(new Error("the API never writes events")),
    patchEvent: () => Promise.reject(new Error("the API never writes events")),
    cancelEvent: () => Promise.reject(new Error("the API never writes events")),
    getEvent: () => Promise.reject(new Error("the API never reads events")),
  };

  function reset(): void {
    next.failList = null;
    listedWith.length = 0;
  }

  return { client, next, listedWith, reset };
}

describe.skipIf(parked || !databaseUrl)("calendar integrations", () => {
  let app: AppInstance;
  /** A second app with no Google credentials at all. See "not configured". */
  let bareApp: AppInstance;
  let google: ReturnType<typeof stubGoogleOAuth>;
  let calendar: ReturnType<typeof stubGoogleCalendar>;

  beforeAll(async () => {
    google = stubGoogleOAuth();
    calendar = stubGoogleCalendar();

    const base = {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      APP_BASE_URL,
      API_BASE_URL: "http://localhost:3001",
      DATABASE_URL: databaseUrl!,
      BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
    };

    app = await buildApp({
      env: loadEnv({
        source: {
          ...base,
          GOOGLE_CLIENT_ID: "123.apps.googleusercontent.com",
          GOOGLE_CLIENT_SECRET: "GOCSPX-not-a-real-secret",
          GOOGLE_REDIRECT_URI: "http://localhost:3001/v1/integrations/google/callback",
          GOOGLE_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
        },
        loadDotenvFile: false,
      }),
      logger: false,
      rateLimit: false,
      googleOAuthClient: google.client,
      googleCalendarClient: calendar.client,
    });
    await app.ready();

    // Deliberately not given the stub either: "the platform has not configured
    // this" has to be reachable exactly as an operator would meet it, which is
    // with none of the four variables set (CI's default for every suite).
    bareApp = await buildApp({
      env: loadEnv({ source: base, loadDotenvFile: false }),
      logger: false,
      rateLimit: false,
    });
    await bareApp.ready();
  });

  afterAll(async () => {
    await app.prisma.tenant.deleteMany({ where: { slug: { endsWith: RUN } } });
    await app.prisma.user.deleteMany({ where: { email: { endsWith: `${RUN}@example.test` } } });
    await app.close();
    await bareApp.close();
    resetGoogleOAuthForTests();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  function cookiesFrom(headers: { "set-cookie"?: string | string[] | undefined }): string {
    const setCookie = headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];

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
    expect(response.statusCode, response.body).toBeLessThan(400);

    const user = await app.prisma.user.findUnique({ where: { email } });
    return { cookie: cookiesFrom(response.headers), email, id: user!.id };
  }

  function as(cookie: string, tenantId?: string): Record<string, string> {
    return { cookie, ...(tenantId === undefined ? {} : { "x-tenant-id": tenantId }) };
  }

  /** An organization with one provider — everything a connection needs. */
  async function clinic(label: string) {
    const owner = await signUp(label);
    const slug = `${label}-${RUN}`;

    const created = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: as(owner.cookie),
      payload: { name: label, slug },
    });
    expect(created.statusCode, created.body).toBe(201);
    const tenantId = created.json<{ id: string }>().id;

    const provider = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: as(owner.cookie, tenantId),
      payload: { displayName: "Dr. Kovács Anna", email: `anna-${label}@example.test` },
    });
    expect(provider.statusCode, provider.body).toBe(201);

    return {
      ...owner,
      slug,
      tenantId,
      providerId: provider.json<{ id: string }>().id,
    };
  }

  /** Start a handshake and hand back the state Google would echo. */
  async function startConnect(
    site: { cookie: string; tenantId: string; providerId: string },
    returnPath?: string,
  ): Promise<{ state: string; authorizationUrl: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrations/google/connect",
      headers: as(site.cookie, site.tenantId),
      payload: { providerId: site.providerId, ...(returnPath === undefined ? {} : { returnPath }) },
    });
    expect(response.statusCode, response.body).toBe(201);

    const { authorizationUrl } = response.json<{ authorizationUrl: string }>();
    const state = new URL(authorizationUrl).searchParams.get("state");
    expect(state).toBeTruthy();

    return { state: state!, authorizationUrl };
  }

  function callback(args: {
    state?: string | undefined;
    code?: string | undefined;
    error?: string | undefined;
    cookie?: string | undefined;
  }) {
    const query = new URLSearchParams();
    if (args.state !== undefined) query.set("state", args.state);
    if (args.code !== undefined) query.set("code", args.code);
    if (args.error !== undefined) query.set("error", args.error);

    return app.inject({
      method: "GET",
      url: `/v1/integrations/google/callback?${query.toString()}`,
      headers: args.cookie === undefined ? {} : { cookie: args.cookie },
    });
  }

  /** The `?calendar=` reason on a redirect, plus the assertion nobody may skip. */
  function outcomeOf(response: { statusCode: number; headers: Record<string, unknown> }): string {
    expect(response.statusCode).toBe(302);

    const location = String(response.headers["location"]);
    // Every path through the callback, success or not, lands on our own origin.
    expect(location.startsWith(APP_BASE_URL)).toBe(true);

    return new URL(location).searchParams.get("calendar") ?? "";
  }

  /** A clinic that has been all the way through consent. */
  async function connected(label: string) {
    google.reset();
    calendar.reset();
    google.next.accountEmail = `${label}-${RUN}@gmail.com`;

    const site = await clinic(label);
    const { state } = await startConnect(site);
    expect(outcomeOf(await callback({ state, code: "4/0Acode", cookie: site.cookie }))).toBe(
      "connected",
    );

    const integration = await app.prisma.calendarIntegration.findFirstOrThrow({
      where: { tenantId: site.tenantId },
    });

    return { site, integration };
  }

  /**
   * Bookings written straight into the database.
   *
   * The booking flow is proved end to end in `booking.test.ts`; what matters
   * here is only which rows the backfill picks up, and driving holds and
   * confirmations through HTTP to produce them would test that flow a second
   * time and this one less clearly.
   */
  async function seedBookings(
    site: { tenantId: string; providerId: string },
    entries: { hoursFromNow: number; status: "CONFIRMED" | "CANCELLED" | "PENDING" }[],
  ): Promise<string[]> {
    const customer = await app.prisma.customer.create({
      data: { tenantId: site.tenantId, fullName: "Nagy Béla" },
    });

    const service = await app.prisma.service.create({
      data: {
        tenantId: site.tenantId,
        name: "Consultation",
        slug: `consult-${randomBytes(3).toString("hex")}`,
        durationMinutes: 30,
      },
    });

    const ids: string[] = [];

    for (const [index, entry] of entries.entries()) {
      const startAt = new Date(Date.now() + entry.hoursFromNow * 3_600_000);

      const booking = await app.prisma.booking.create({
        data: {
          tenantId: site.tenantId,
          reference: `BK-${randomBytes(3).toString("hex")}-${String(index)}`,
          customerId: customer.id,
          providerId: site.providerId,
          serviceId: service.id,
          startAt,
          endAt: new Date(startAt.getTime() + 30 * 60_000),
          status: entry.status,
          // `bookings_cancelled_at_present` refuses a cancellation with no
          // timestamp — the database enforcing that the two travel together.
          ...(entry.status === "CANCELLED" ? { cancelledAt: new Date() } : {}),
          customerNameSnapshot: "Nagy Béla",
          serviceNameSnapshot: "Consultation",
        },
      });

      ids.push(booking.id);
    }

    return ids;
  }

  /** A clinic plus a PROVIDER member linked to its provider record. */
  async function withLinkedProvider(label: string) {
    const site = await clinic(label);
    const member = await signUp(`${label}-provider`);

    // Invited as ADMIN and promoted: PROVIDER carries a diary, which this route
    // cannot supply (phase-9-provider-onboarding §2.11).
    const invited = await app.inject({
      method: "POST",
      url: "/v1/members/invitations",
      headers: as(site.cookie, site.tenantId),
      payload: { email: member.email, role: "ADMIN" },
    });
    const token = invited.json<{ acceptUrl: string }>().acceptUrl.split("/").pop()!;

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

  function readState(site: { cookie: string; tenantId: string }) {
    return app.inject({
      method: "GET",
      url: "/v1/integrations/google",
      headers: as(site.cookie, site.tenantId),
    });
  }

  // -------------------------------------------------------------------------
  // Not configured
  // -------------------------------------------------------------------------

  describe("when the platform has no Google credentials", () => {
    it("answers 503, not 404", async () => {
      // Rule 4's literal form. The difference matters to whoever is reading the
      // logs: 404 says "you asked for something that does not exist", and this
      // deployment simply has not been given a client id.
      const owner = await signUp("bare-owner");
      const created = await bareApp.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { cookie: owner.cookie },
        payload: { name: "Bare", slug: `bare-${RUN}` },
      });
      expect(created.statusCode, created.body).toBe(201);
      const tenantId = created.json<{ id: string }>().id;

      const provider = await bareApp.inject({
        method: "POST",
        url: "/v1/providers",
        headers: { cookie: owner.cookie, "x-tenant-id": tenantId },
        payload: { displayName: "Nobody", email: `nobody-${RUN}@example.test` },
      });
      expect(provider.statusCode, provider.body).toBe(201);

      const response = await bareApp.inject({
        method: "POST",
        url: "/v1/integrations/google/connect",
        headers: { cookie: owner.cookie, "x-tenant-id": tenantId },
        payload: { providerId: provider.json<{ id: string }>().id },
      });

      expect(response.statusCode, response.body).toBe(503);
      expect(response.json().error.code).toBe(ErrorCodes.SERVICE_UNAVAILABLE);
    });

    it("keeps the callback reachable and inert", async () => {
      // Registered rather than absent, so a stale bookmark or a Google retry
      // does not produce a 404 that reads as a routing bug.
      const response = await bareApp.inject({
        method: "GET",
        url: "/v1/integrations/google/callback?code=x&state=y",
      });

      expect(response.statusCode).toBe(503);
    });
  });

  // -------------------------------------------------------------------------
  // Starting the handshake
  // -------------------------------------------------------------------------

  describe("connect", () => {
    it("returns Google's consent URL and stores only a digest of the state", async () => {
      const site = await clinic("connect");
      const { state, authorizationUrl } = await startConnect(site);

      const url = new URL(authorizationUrl);
      expect(url.origin).toBe("https://accounts.google.com");
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("prompt")).toBe("consent");
      // The account chooser is pre-filled with the signed-in address; they may
      // still pick a different Google account, and the callback records that one.
      expect(url.searchParams.get("login_hint")).toBe(site.email);

      const rows = await app.prisma.calendarOauthState.findMany({
        where: { tenantId: site.tenantId },
      });

      expect(rows).toHaveLength(1);
      // The same discipline an invitation token gets: a database leak yields
      // nothing replayable.
      expect(rows[0]!.stateHash).not.toBe(state);
      expect(rows[0]!.stateHash).toHaveLength(64);
      expect(rows[0]!.consumedAt).toBeNull();
    });

    it("refuses a return path that points at another site", async () => {
      const site = await clinic("redirect");

      for (const returnPath of [
        "https://evil.example/steal",
        // Protocol-relative: starts with a slash, means another host, and is the
        // spelling that gets past a naive "must begin with /" check.
        "//evil.example/steal",
        // Browsers normalise a backslash to a forward slash in a URL.
        "/\\evil.example",
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/integrations/google/connect",
          headers: as(site.cookie, site.tenantId),
          payload: { providerId: site.providerId, returnPath },
        });

        expect(response.statusCode, `${returnPath} was accepted`).toBe(422);
      }
    });

    it("cannot aim a connection at another organization's provider", async () => {
      const mine = await clinic("mine");
      const theirs = await clinic("theirs");

      const response = await app.inject({
        method: "POST",
        url: "/v1/integrations/google/connect",
        headers: as(mine.cookie, mine.tenantId),
        payload: { providerId: theirs.providerId },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe(ErrorCodes.PROVIDER_NOT_FOUND);
    });
  });

  // -------------------------------------------------------------------------
  // The callback
  // -------------------------------------------------------------------------

  describe("callback", () => {
    it("seals both tokens before they touch the database", async () => {
      // **The assertion this step exists for.** Everything else here is about
      // handshake hygiene; this is about a refresh token being a permanent
      // bearer credential for somebody's calendar (PRD §9.10).
      google.reset();
      google.next.accountEmail = `seal-${RUN}@gmail.com`;

      const site = await clinic("seal");
      const { state } = await startConnect(site);

      const response = await callback({ state, code: "4/0Acode", cookie: site.cookie });
      expect(outcomeOf(response)).toBe("connected");

      const integration = await app.prisma.calendarIntegration.findFirst({
        where: { tenantId: site.tenantId },
      });

      expect(integration).not.toBeNull();
      expect(integration!.status).toBe("ACTIVE");
      expect(integration!.accountEmail).toBe(`seal-${RUN}@gmail.com`);
      expect(integration!.providerId).toBe(site.providerId);
      expect(integration!.userId).toBe(site.id);

      // Cheap, and it catches the whole class: a plaintext token stored by
      // mistake contains itself.
      expect(integration!.sealedRefreshToken).not.toContain(REFRESH_TOKEN);
      expect(integration!.sealedAccessToken).not.toContain(ACCESS_TOKEN);
      expect(looksSealed(integration!.sealedRefreshToken!)).toBe(true);

      // And it round-trips under the configured key, which "looks sealed" alone
      // would not prove.
      const key = parseEncryptionKey(ENCRYPTION_KEY);
      expect(openToken(integration!.sealedRefreshToken!, key)).toBe(REFRESH_TOKEN);
      expect(openToken(integration!.sealedAccessToken!, key)).toBe(ACCESS_TOKEN);
    });

    it("honours a recorded return path, and carries the outcome on it", async () => {
      google.reset();
      google.next.accountEmail = `return-${RUN}@gmail.com`;

      const site = await clinic("return");
      const { state } = await startConnect(site, "/dashboard/providers?tab=calendar");

      const response = await callback({ state, code: "4/0Acode", cookie: site.cookie });
      const location = new URL(String(response.headers["location"]));

      expect(location.pathname).toBe("/dashboard/providers");
      expect(location.searchParams.get("tab")).toBe("calendar");
      expect(location.searchParams.get("calendar")).toBe("connected");
      expect(location.searchParams.get("integration")).toBeTruthy();
    });

    it("refuses a replayed state, and creates nothing the second time", async () => {
      // Single-use is enforced by an `updateMany` guarded on `consumedAt`, so
      // this is really a test that the database decides (rule 14) — a read
      // followed by a write would let both attempts through.
      google.reset();
      google.next.accountEmail = `replay-${RUN}@gmail.com`;

      const site = await clinic("replay");
      const { state } = await startConnect(site);

      expect(outcomeOf(await callback({ state, code: "4/0Acode", cookie: site.cookie }))).toBe(
        "connected",
      );

      // A second, different Google account on the replayed handshake: if the
      // burn failed, this would appear as a second integration.
      google.next.accountEmail = `replay-second-${RUN}@gmail.com`;

      expect(outcomeOf(await callback({ state, code: "4/0Acode", cookie: site.cookie }))).toBe(
        "invalid_state",
      );

      const integrations = await app.prisma.calendarIntegration.findMany({
        where: { tenantId: site.tenantId },
      });
      expect(integrations).toHaveLength(1);
      expect(integrations[0]!.accountEmail).toBe(`replay-${RUN}@gmail.com`);
    });

    it("treats an unknown state as an expired one", async () => {
      // One answer for unknown, expired and already-burned. Distinguishing them
      // would let somebody probe for live handshakes.
      const response = await callback({ state: "not-a-real-state", code: "4/0Acode" });
      expect(outcomeOf(response)).toBe("invalid_state");
    });

    it("stores nothing when the provider declines at Google", async () => {
      google.reset();
      const site = await clinic("denied");
      const { state } = await startConnect(site);

      const response = await callback({ state, error: "access_denied", cookie: site.cookie });
      expect(outcomeOf(response)).toBe("access_denied");

      await expect(
        app.prisma.calendarIntegration.count({ where: { tenantId: site.tenantId } }),
      ).resolves.toBe(0);
      // Burned anyway: a change of mind is a second click, not a resumable state.
      const row = await app.prisma.calendarOauthState.findFirst({
        where: { tenantId: site.tenantId },
      });
      expect(row!.consumedAt).not.toBeNull();
    });

    it("refuses a handshake finished under somebody else's session", async () => {
      google.reset();
      const site = await clinic("hijack");
      const stranger = await signUp("stranger");
      const { state } = await startConnect(site);

      const response = await callback({ state, code: "4/0Acode", cookie: stranger.cookie });
      expect(outcomeOf(response)).toBe("session_mismatch");

      await expect(
        app.prisma.calendarIntegration.count({ where: { tenantId: site.tenantId } }),
      ).resolves.toBe(0);
    });

    it("says so when Google refuses the code, and stores nothing", async () => {
      google.reset();
      google.next.failExchange = true;

      const site = await clinic("exchange");
      const { state } = await startConnect(site);

      const response = await callback({ state, code: "4/0Aexpired", cookie: site.cookie });
      expect(outcomeOf(response)).toBe("exchange_failed");

      await expect(
        app.prisma.calendarIntegration.count({ where: { tenantId: site.tenantId } }),
      ).resolves.toBe(0);
    });

    it("refuses a first connection that comes back without a refresh token", async () => {
      // `prompt=consent` is meant to guarantee one. Storing the access token
      // alone would produce an integration that works until lunchtime and then
      // stops, with nothing in any log to say why.
      google.reset();
      google.next.refreshToken = undefined;
      google.next.accountEmail = `norefresh-${RUN}@gmail.com`;

      const site = await clinic("norefresh");
      const { state } = await startConnect(site);

      const response = await callback({ state, code: "4/0Acode", cookie: site.cookie });
      expect(outcomeOf(response)).toBe("no_refresh_token");

      await expect(
        app.prisma.calendarIntegration.count({ where: { tenantId: site.tenantId } }),
      ).resolves.toBe(0);
    });

    it("records a consent that withheld the scope, but not as ACTIVE", async () => {
      // Google's consent screen has checkboxes. The row is written — the granted
      // scopes are what make this diagnosable as itself rather than as a 403
      // three days later — but never as a status that claims it can do work.
      google.reset();
      google.next.scopes = ["https://www.googleapis.com/auth/userinfo.email"];
      google.next.accountEmail = `partial-${RUN}@gmail.com`;

      const site = await clinic("partial");
      const { state } = await startConnect(site);

      const response = await callback({ state, code: "4/0Acode", cookie: site.cookie });
      expect(outcomeOf(response)).toBe("missing_scope");

      const integration = await app.prisma.calendarIntegration.findFirst({
        where: { tenantId: site.tenantId },
      });

      expect(integration!.status).toBe("NEEDS_RECONNECT");
      expect(integration!.lastError).toContain("calendar.events");
      expect(integration!.scopes).toEqual(["https://www.googleapis.com/auth/userinfo.email"]);
    });

    it("reconnects the same account in place, keeping a refresh token Google withheld", async () => {
      // Two properties in one test because they are one behaviour. Google issues
      // a refresh token once per grant; a re-consent that returns only an access
      // token must leave the stored one alone, or the reconnection *creates* the
      // failure it was meant to repair.
      google.reset();
      google.next.accountEmail = `again-${RUN}@gmail.com`;

      const site = await clinic("again");
      const first = await startConnect(site);
      expect(
        outcomeOf(await callback({ state: first.state, code: "4/0Acode", cookie: site.cookie })),
      ).toBe("connected");

      const before = await app.prisma.calendarIntegration.findFirstOrThrow({
        where: { tenantId: site.tenantId },
      });

      google.next.refreshToken = undefined;
      const second = await startConnect(site);
      expect(
        outcomeOf(await callback({ state: second.state, code: "4/0Aagain", cookie: site.cookie })),
      ).toBe("connected");

      const integrations = await app.prisma.calendarIntegration.findMany({
        where: { tenantId: site.tenantId },
      });

      expect(integrations).toHaveLength(1);
      expect(integrations[0]!.id).toBe(before.id);

      const key = parseEncryptionKey(ENCRYPTION_KEY);
      expect(openToken(integrations[0]!.sealedRefreshToken!, key)).toBe(REFRESH_TOKEN);
    });
  });

  // -------------------------------------------------------------------------
  // Reading our own state
  // -------------------------------------------------------------------------

  describe("reading state", () => {
    it("distinguishes an unconfigured platform from one nobody has connected", async () => {
      // The same empty array in both cases, and opposite words on the screen:
      // "your administrator has not set this up" versus "connect your calendar".
      const owner = await signUp("state-bare");
      const created = await bareApp.inject({
        method: "POST",
        url: "/v1/tenants",
        headers: { cookie: owner.cookie },
        payload: { name: "State", slug: `state-bare-${RUN}` },
      });
      expect(created.statusCode, created.body).toBe(201);

      const unconfigured = await bareApp.inject({
        method: "GET",
        url: "/v1/integrations/google",
        headers: {
          cookie: owner.cookie,
          "x-tenant-id": created.json<{ id: string }>().id,
        },
      });

      expect(unconfigured.statusCode, unconfigured.body).toBe(200);
      expect(unconfigured.json()).toEqual({ configured: false, integrations: [] });

      const site = await clinic("state-empty");
      const configured = await readState(site);

      expect(configured.json()).toEqual({ configured: true, integrations: [] });
    });

    it("reports the account, its calendars and the sync counts §25.6 asks for", async () => {
      const { site, integration } = await connected("state");

      const selected = await app.inject({
        method: "POST",
        url: `/v1/integrations/google/${integration.id}/calendars/select`,
        headers: as(site.cookie, site.tenantId),
        payload: { externalCalendarId: "anna@example.test", calendarName: "Anna" },
      });
      expect(selected.statusCode, selected.body).toBe(200);

      await seedBookings(site, [{ hoursFromNow: 48, status: "CONFIRMED" }]);
      await app.inject({
        method: "POST",
        url: `/v1/integrations/google/${integration.id}/calendars/select`,
        headers: as(site.cookie, site.tenantId),
        payload: { externalCalendarId: "anna@example.test" },
      });

      const response = await readState(site);
      const body = response.json<{
        integrations: {
          id: string;
          accountEmail: string;
          providerName: string | null;
          status: string;
          calendars: { externalCalendarId: string; writeBookings: boolean; readBusy: boolean }[];
          sync: { pending: number; failed: number };
        }[];
      }>();

      expect(body.integrations).toHaveLength(1);
      expect(body.integrations[0]).toMatchObject({
        id: integration.id,
        accountEmail: `state-${RUN}@gmail.com`,
        providerName: "Dr. Kovács Anna",
        status: "ACTIVE",
      });
      expect(body.integrations[0]!.calendars).toEqual([
        expect.objectContaining({
          externalCalendarId: "anna@example.test",
          writeBookings: true,
          // Part 2 turns this on. Asserted so the day it flips is a deliberate act.
          readBusy: false,
        }),
      ]);
      expect(body.integrations[0]!.sync).toMatchObject({ pending: 1, failed: 0 });
    });

    it("shows a provider their own connection and not a colleague's", async () => {
      // Filtered rather than refused: asking for the page should give the page,
      // showing what is theirs. A 403 would be right for one row and wrong here.
      const { site, member } = await withLinkedProvider("state-own");

      const colleague = await app.inject({
        method: "POST",
        url: "/v1/providers",
        headers: as(site.cookie, site.tenantId),
        payload: {
          displayName: "Dr. Nagy Béla",
          email: `state-bela-${RUN}@example.test`,
        },
      });
      const colleagueId = colleague.json<{ id: string }>().id;

      // Two connections in one tenant: one for each provider.
      await app.prisma.calendarIntegration.createMany({
        data: [
          {
            tenantId: site.tenantId,
            userId: member.id,
            providerId: site.providerId,
            accountEmail: `own-${RUN}@gmail.com`,
          },
          {
            tenantId: site.tenantId,
            userId: site.id,
            providerId: colleagueId,
            accountEmail: `other-${RUN}@gmail.com`,
          },
        ],
      });

      const asProvider = await readState({ cookie: member.cookie, tenantId: site.tenantId });
      const asOwner = await readState(site);

      expect(asProvider.statusCode, asProvider.body).toBe(200);
      expect(asOwner.statusCode, asOwner.body).toBe(200);

      expect(
        asProvider.json<{ integrations: { accountEmail: string }[] }>().integrations,
      ).toHaveLength(1);
      expect(
        asProvider.json<{ integrations: { accountEmail: string }[] }>().integrations[0]!
          .accountEmail,
      ).toBe(`own-${RUN}@gmail.com`);

      expect(asOwner.json<{ integrations: unknown[] }>().integrations).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Listing calendars, and the token refresh behind it
  // -------------------------------------------------------------------------

  describe("listing calendars", () => {
    it("returns what Google says, marking the one already selected", async () => {
      const { site, integration } = await connected("list");

      const first = await app.inject({
        method: "GET",
        url: `/v1/integrations/google/${integration.id}/calendars`,
        headers: as(site.cookie, site.tenantId),
      });

      expect(first.statusCode, first.body).toBe(200);
      expect(first.json<{ items: { id: string; selected: boolean }[] }>().items).toEqual([
        expect.objectContaining({ id: "anna@example.test", primary: true, selected: false }),
        expect.objectContaining({ id: "team@group.calendar.google.com", selected: false }),
      ]);

      await app.inject({
        method: "POST",
        url: `/v1/integrations/google/${integration.id}/calendars/select`,
        headers: as(site.cookie, site.tenantId),
        payload: { externalCalendarId: "team@group.calendar.google.com" },
      });

      const second = await app.inject({
        method: "GET",
        url: `/v1/integrations/google/${integration.id}/calendars`,
        headers: as(site.cookie, site.tenantId),
      });

      const items = second.json<{ items: { id: string; selected: boolean }[] }>().items;
      expect(items.find((entry) => entry.id === "team@group.calendar.google.com")?.selected).toBe(
        true,
      );
      expect(items.find((entry) => entry.id === "anna@example.test")?.selected).toBe(false);
    });

    it("refreshes a stale access token and re-seals the replacement", async () => {
      // The token lasts an hour and the connection lasts until somebody revokes
      // it, so this path runs far more often than the consent one. Persisting
      // the refreshed token is the whole reason it lives in the service rather
      // than in the client: a client that refreshed silently would leave the
      // database holding a token it had already replaced.
      const { site, integration } = await connected("refresh");

      await app.prisma.calendarIntegration.update({
        where: { id: integration.id },
        data: { accessTokenExpiresAt: new Date(Date.now() - 60_000) },
      });

      const refreshedAccess = "ya29.a0RefreshedAccessToken";
      google.next.refreshed = {
        accessToken: refreshedAccess,
        refreshToken: undefined,
        expiresAt: new Date(Date.now() + 3_600_000),
        scopes: [...ALL_SCOPES],
      };

      const response = await app.inject({
        method: "GET",
        url: `/v1/integrations/google/${integration.id}/calendars`,
        headers: as(site.cookie, site.tenantId),
      });

      expect(response.statusCode, response.body).toBe(200);
      // Google was called with the *new* token, not the stale one.
      expect(calendar.listedWith.at(-1)).toBe(refreshedAccess);

      const key = parseEncryptionKey(ENCRYPTION_KEY);
      const after = await app.prisma.calendarIntegration.findUniqueOrThrow({
        where: { id: integration.id },
      });

      expect(openToken(after.sealedAccessToken!, key)).toBe(refreshedAccess);
      // The refresh token is untouched: Google issues one per grant, and this
      // response carried none.
      expect(openToken(after.sealedRefreshToken!, key)).toBe(REFRESH_TOKEN);
    });

    it("marks the connection as needing a human when the grant is gone", async () => {
      // `invalid_grant` arrives as a 400, which is why the classifier reads the
      // reason before the status. Getting that order wrong retries a revoked
      // token forever and never reports the disconnection.
      const { site, integration } = await connected("revoked");

      await app.prisma.calendarIntegration.update({
        where: { id: integration.id },
        data: { accessTokenExpiresAt: new Date(Date.now() - 60_000) },
      });
      google.next.refreshError = { status: 400, reason: "invalid_grant" };

      const response = await app.inject({
        method: "GET",
        url: `/v1/integrations/google/${integration.id}/calendars`,
        headers: as(site.cookie, site.tenantId),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe(ErrorCodes.CALENDAR_INTEGRATION_INACTIVE);

      const after = await app.prisma.calendarIntegration.findUniqueOrThrow({
        where: { id: integration.id },
      });
      expect(after.status).toBe("NEEDS_RECONNECT");
      expect(after.lastError).toBe("invalid_grant");
      // Cleared with it: a stale token left behind turns a clear "reconnect me"
      // into an intermittent 401 the next caller has to classify all over again.
      expect(after.sealedAccessToken).toBeNull();
    });

    it("reports a Google outage as temporary, and changes nothing", async () => {
      const { site, integration } = await connected("outage");
      calendar.next.failList = { status: 503, reason: "backendError" };

      const response = await app.inject({
        method: "GET",
        url: `/v1/integrations/google/${integration.id}/calendars`,
        headers: as(site.cookie, site.tenantId),
      });

      expect(response.statusCode).toBe(503);

      const after = await app.prisma.calendarIntegration.findUniqueOrThrow({
        where: { id: integration.id },
      });
      // Still ACTIVE. A 503 is not a reason to make somebody reconnect.
      expect(after.status).toBe("ACTIVE");
    });

    it("refuses a connection that needs reconnecting", async () => {
      const { site, integration } = await connected("inactive");
      await app.prisma.calendarIntegration.update({
        where: { id: integration.id },
        data: { status: "NEEDS_RECONNECT" },
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/integrations/google/${integration.id}/calendars`,
        headers: as(site.cookie, site.tenantId),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe(ErrorCodes.CALENDAR_INTEGRATION_INACTIVE);
    });
  });

  // -------------------------------------------------------------------------
  // Selecting a calendar, and the backfill
  // -------------------------------------------------------------------------

  describe("selecting a calendar", () => {
    it("queues the upcoming confirmed bookings and nothing else", async () => {
      const { site, integration } = await connected("backfill");

      const ids = await seedBookings(site, [
        { hoursFromNow: 24, status: "CONFIRMED" },
        { hoursFromNow: 72, status: "CONFIRMED" },
        // Already happened: nobody needs a calendar entry for an appointment
        // they have been to.
        { hoursFromNow: -24, status: "CONFIRMED" },
        { hoursFromNow: 48, status: "CANCELLED" },
        // Record §3.8: an appointment nobody has accepted appearing in a diary
        // is worse than its absence.
        { hoursFromNow: 96, status: "PENDING" },
      ]);

      const response = await app.inject({
        method: "POST",
        url: `/v1/integrations/google/${integration.id}/calendars/select`,
        headers: as(site.cookie, site.tenantId),
        payload: { externalCalendarId: "anna@example.test", calendarName: "Anna" },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ backfilled: 2, replacedCalendarId: null });

      const queued = await app.prisma.calendarEventMapping.findMany({
        where: { tenantId: site.tenantId },
      });

      expect(queued).toHaveLength(2);
      expect(new Set(queued.map((row) => row.bookingId))).toEqual(new Set([ids[0], ids[1]]));
      expect(queued.every((row) => row.syncStatus === "PENDING")).toBe(true);
      // Derived from `(bookingId, calendarMappingId)`, so it is computable before
      // the row exists and the column can be NOT NULL (§2.3).
      expect(queued.every((row) => /^bam[0-9a-v]{32}$/u.test(row.externalEventId))).toBe(true);
    });

    it("is safe to repeat", async () => {
      // `createMany({ skipDuplicates })` against the unique index, never a read
      // followed by a write — so a double-clicked button costs one query and
      // queues nothing twice (rule 14).
      const { site, integration } = await connected("repeat");
      await seedBookings(site, [{ hoursFromNow: 24, status: "CONFIRMED" }]);

      const select = () =>
        app.inject({
          method: "POST",
          url: `/v1/integrations/google/${integration.id}/calendars/select`,
          headers: as(site.cookie, site.tenantId),
          payload: { externalCalendarId: "anna@example.test" },
        });

      const first = await select();
      const second = await select();

      expect(first.json().backfilled).toBe(1);
      expect(second.json().backfilled).toBe(0);
      expect(second.json().replacedCalendarId).toBeNull();

      await expect(
        app.prisma.calendarEventMapping.count({ where: { tenantId: site.tenantId } }),
      ).resolves.toBe(1);
    });

    it("moves to a different calendar without tripping the one-per-provider index", async () => {
      // The partial unique index makes "two writing calendars" unrepresentable,
      // so the old mapping must be deactivated in the same transaction. Without
      // that this request is refused by PostgreSQL rather than by us.
      const { site, integration } = await connected("switch");
      await seedBookings(site, [{ hoursFromNow: 24, status: "CONFIRMED" }]);

      await app.inject({
        method: "POST",
        url: `/v1/integrations/google/${integration.id}/calendars/select`,
        headers: as(site.cookie, site.tenantId),
        payload: { externalCalendarId: "anna@example.test" },
      });

      const moved = await app.inject({
        method: "POST",
        url: `/v1/integrations/google/${integration.id}/calendars/select`,
        headers: as(site.cookie, site.tenantId),
        payload: { externalCalendarId: "team@group.calendar.google.com" },
      });

      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().replacedCalendarId).toBe("anna@example.test");
      // The new calendar gets its own copy of the booking; the old mapping's
      // event stays where it is (known limit 6), which is why the screen warns.
      expect(moved.json().backfilled).toBe(1);

      const mappings = await app.prisma.calendarMapping.findMany({
        where: { tenantId: site.tenantId },
        orderBy: { createdAt: "asc" },
      });

      expect(mappings).toHaveLength(2);
      expect(mappings[0]).toMatchObject({
        externalCalendarId: "anna@example.test",
        active: false,
      });
      expect(mappings[1]).toMatchObject({
        externalCalendarId: "team@group.calendar.google.com",
        active: true,
        writeBookings: true,
      });
    });

    it("cannot select a calendar on another organization's connection", async () => {
      const { integration } = await connected("select-hidden");
      const outsider = await clinic("select-outsider");

      const response = await app.inject({
        method: "POST",
        url: `/v1/integrations/google/${integration.id}/calendars/select`,
        headers: as(outsider.cookie, outsider.tenantId),
        payload: { externalCalendarId: "anna@example.test" },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Retrying
  // -------------------------------------------------------------------------

  describe("sync", () => {
    it("requeues parked rows and leaves live ones alone", async () => {
      const { site, integration } = await connected("retry");
      await seedBookings(site, [
        { hoursFromNow: 24, status: "CONFIRMED" },
        { hoursFromNow: 48, status: "CONFIRMED" },
        { hoursFromNow: 72, status: "CONFIRMED" },
      ]);

      await app.inject({
        method: "POST",
        url: `/v1/integrations/google/${integration.id}/calendars/select`,
        headers: as(site.cookie, site.tenantId),
        payload: { externalCalendarId: "anna@example.test" },
      });

      const rows = await app.prisma.calendarEventMapping.findMany({
        where: { tenantId: site.tenantId },
        orderBy: { createdAt: "asc" },
      });
      expect(rows).toHaveLength(3);

      await app.prisma.calendarEventMapping.update({
        where: { id: rows[0]!.id },
        data: { syncStatus: "FAILED", attempts: 8, lastError: "notFound" },
      });
      // A worker may be holding this one right now.
      await app.prisma.calendarEventMapping.update({
        where: { id: rows[1]!.id },
        data: { syncStatus: "SYNCING", claimedAt: new Date() },
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/integrations/google/${integration.id}/sync`,
        headers: as(site.cookie, site.tenantId),
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ requeued: 1 });

      const revived = await app.prisma.calendarEventMapping.findUniqueOrThrow({
        where: { id: rows[0]!.id },
      });
      expect(revived).toMatchObject({ syncStatus: "PENDING", attempts: 0, lastError: null });

      const untouched = await app.prisma.calendarEventMapping.findUniqueOrThrow({
        where: { id: rows[1]!.id },
      });
      expect(untouched.syncStatus).toBe("SYNCING");
    });

    it("refuses to retry through a connection that needs reconnecting", async () => {
      // Requeueing would only park the rows again, one attempt budget later,
      // and tell the provider nothing about what they actually have to do.
      const { site, integration } = await connected("retry-dead");
      await app.prisma.calendarIntegration.update({
        where: { id: integration.id },
        data: { status: "NEEDS_RECONNECT" },
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/integrations/google/${integration.id}/sync`,
        headers: as(site.cookie, site.tenantId),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe(ErrorCodes.CALENDAR_INTEGRATION_INACTIVE);
    });
  });

  // -------------------------------------------------------------------------
  // Disconnecting
  // -------------------------------------------------------------------------

  describe("disconnect", () => {
    /** A connected account with one selected calendar. */
    async function connectedWithMapping(label: string) {
      const { site, integration } = await connected(label);

      const mapping = await app.prisma.calendarMapping.create({
        data: {
          tenantId: site.tenantId,
          calendarIntegrationId: integration.id,
          providerId: site.providerId,
          externalCalendarId: `${label}@example.test`,
          calendarName: "Work",
        },
      });

      return { site, integration, mapping };
    }

    it("clears the credentials, stops the calendars and revokes at Google", async () => {
      const { site, integration, mapping } = await connectedWithMapping("bye");
      const revokedBefore = google.revoked.length;

      const response = await app.inject({
        method: "DELETE",
        url: `/v1/integrations/google/${integration.id}`,
        headers: as(site.cookie, site.tenantId),
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        status: "DISCONNECTED",
        deactivatedCalendars: 1,
        revokedAtGoogle: true,
      });

      // Revoked with the *plaintext* token, which means the API opened what it
      // sealed — the round trip proved from the other end.
      expect(google.revoked.slice(revokedBefore)).toEqual([REFRESH_TOKEN]);

      const after = await app.prisma.calendarIntegration.findUniqueOrThrow({
        where: { id: integration.id },
      });
      expect(after.status).toBe("DISCONNECTED");
      expect(after.sealedRefreshToken).toBeNull();
      expect(after.sealedAccessToken).toBeNull();

      // The row survives — §34.5 audits disconnection and the trail needs
      // something to point at, and a reconnect should resume rather than restart.
      const stoppedMapping = await app.prisma.calendarMapping.findUniqueOrThrow({
        where: { id: mapping.id },
      });
      expect(stoppedMapping.active).toBe(false);
    });

    it("still disconnects when Google refuses to revoke", async () => {
      // Best effort by design. The person asked to be disconnected; a Google
      // outage must not be able to overrule that.
      const { site, integration } = await connectedWithMapping("stubborn");
      google.next.failRevoke = true;

      const response = await app.inject({
        method: "DELETE",
        url: `/v1/integrations/google/${integration.id}`,
        headers: as(site.cookie, site.tenantId),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().revokedAtGoogle).toBe(false);

      const after = await app.prisma.calendarIntegration.findUniqueOrThrow({
        where: { id: integration.id },
      });
      expect(after.status).toBe("DISCONNECTED");
      expect(after.sealedRefreshToken).toBeNull();
    });

    it("hides another organization's connection behind the same 404", async () => {
      const { integration } = await connectedWithMapping("hidden");
      const outsider = await clinic("outsider");

      const response = await app.inject({
        method: "DELETE",
        url: `/v1/integrations/google/${integration.id}`,
        headers: as(outsider.cookie, outsider.tenantId),
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // The `:own` permission
  // -------------------------------------------------------------------------

  describe("who may connect a calendar", () => {
    it("lets a provider connect their own diary and nobody else's", async () => {
      const { site, member } = await withLinkedProvider("own");

      const own = await app.inject({
        method: "POST",
        url: "/v1/integrations/google/connect",
        headers: as(member.cookie, site.tenantId),
        payload: { providerId: site.providerId },
      });
      expect(own.statusCode, own.body).toBe(201);

      const colleague = await app.inject({
        method: "POST",
        url: "/v1/providers",
        headers: as(site.cookie, site.tenantId),
        payload: { displayName: "Dr. Nagy Béla", email: `bela-${RUN}@example.test` },
      });
      expect(colleague.statusCode, colleague.body).toBe(201);

      const theirs = await app.inject({
        method: "POST",
        url: "/v1/integrations/google/connect",
        headers: as(member.cookie, site.tenantId),
        payload: { providerId: colleague.json<{ id: string }>().id },
      });

      expect(theirs.statusCode).toBe(403);
      expect(theirs.json().error.code).toBe(ErrorCodes.FORBIDDEN);
    });

    it("refuses the front desk entirely", async () => {
      // An ASSISTANT manages bookings and no settings, and attaching a Google
      // account to a colleague's diary is a setting.
      const site = await clinic("assistant-site");
      const assistant = await signUp("assistant");

      const invited = await app.inject({
        method: "POST",
        url: "/v1/members/invitations",
        headers: as(site.cookie, site.tenantId),
        payload: { email: assistant.email, role: "ASSISTANT" },
      });
      const token = invited.json<{ acceptUrl: string }>().acceptUrl.split("/").pop()!;

      await app.inject({
        method: "POST",
        url: "/v1/invitations/accept",
        headers: as(assistant.cookie),
        payload: { token },
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/integrations/google/connect",
        headers: as(assistant.cookie, site.tenantId),
        payload: { providerId: site.providerId },
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
