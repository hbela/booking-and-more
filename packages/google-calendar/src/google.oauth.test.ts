import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthorizationUrl,
  createGoogleOAuthClient,
  errorFrom,
  GOOGLE_CALENDAR_SCOPES,
} from "./google.oauth.js";
import { classifyUnknown, GoogleFailureKinds } from "./google.errors.js";

/**
 * The `fetch` layer, against a stubbed `globalThis.fetch` and Google's real
 * response shapes. No network, and no `googleapis` to mock.
 */

const config = {
  clientId: "123.apps.googleusercontent.com",
  clientSecret: "GOCSPX-not-a-real-secret",
  redirectUri: "https://api.example.com/v1/integrations/google/callback",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub `fetch` with one canned response and capture what was sent. */
function stubFetch(response: { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: (response.status ?? 200) < 400,
        status: response.status ?? 200,
        json: () => Promise.resolve(response.body),
      } as Response);
    }),
  );

  return calls;
}

describe("buildAuthorizationUrl", () => {
  it("asks for offline access and forces the consent prompt", () => {
    // The combination that guarantees a refresh token. Without `prompt=consent`
    // Google issues one only on the first ever consent for this client/user
    // pair — so a provider who disconnects and reconnects would get an
    // integration that dies at the first access-token expiry, an hour later.
    const url = new URL(buildAuthorizationUrl(config, { state: "st_1" }));

    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("st_1");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
  });

  it("asks only for the scopes this phase uses", () => {
    // `calendar.readonly` is part 2's and deliberately absent: asking for a
    // permission months before using it is what makes a consent screen alarming.
    const url = new URL(buildAuthorizationUrl(config, { state: "st_1" }));
    const scopes = (url.searchParams.get("scope") ?? "").split(" ");

    expect(scopes).toEqual([...GOOGLE_CALENDAR_SCOPES]);
    expect(scopes).not.toContain("https://www.googleapis.com/auth/calendar.readonly");
    // The narrower events scope, not the full `calendar` one — which would also
    // allow creating and deleting whole calendars.
    expect(scopes).not.toContain("https://www.googleapis.com/auth/calendar");
  });

  it("passes a login hint when there is one, and omits it otherwise", () => {
    const withHint = new URL(
      buildAuthorizationUrl(config, { state: "st", loginHint: "anna@example.test" }),
    );
    const without = new URL(buildAuthorizationUrl(config, { state: "st" }));

    expect(withHint.searchParams.get("login_hint")).toBe("anna@example.test");
    expect(without.searchParams.has("login_hint")).toBe(false);
  });
});

describe("exchangeCode", () => {
  it("reads Google's token response", async () => {
    const calls = stubFetch({
      body: {
        access_token: "ya29.a0AfB_access",
        refresh_token: "1//0gRefresh",
        expires_in: 3599,
        scope: GOOGLE_CALENDAR_SCOPES.join(" "),
        token_type: "Bearer",
      },
    });

    const tokens = await createGoogleOAuthClient(config).exchangeCode("4/0Acode");

    expect(tokens.accessToken).toBe("ya29.a0AfB_access");
    expect(tokens.refreshToken).toBe("1//0gRefresh");
    expect(tokens.scopes).toEqual([...GOOGLE_CALENDAR_SCOPES]);
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Form-encoded, as the token endpoint requires — JSON is silently rejected.
    expect(calls[0]?.init?.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
    });
  });

  it("leaves the refresh token undefined when Google withholds one", async () => {
    // A re-consent may return only an access token. The caller must keep the
    // stored one rather than overwrite it with null — the reason this is
    // `undefined` rather than `null`, and the reason it is documented.
    stubFetch({ body: { access_token: "ya29.access", expires_in: 3599 } });

    const tokens = await createGoogleOAuthClient(config).exchangeCode("4/0Acode");

    expect(tokens.refreshToken).toBeUndefined();
  });

  it("turns invalid_grant into a reconnection, not a retry", async () => {
    // The classification that matters most: it arrives as a 400, and reading it
    // as a plain 400 would park while reading it as transient would retry a
    // revoked token forever.
    stubFetch({
      status: 400,
      body: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
    });

    const failure = await createGoogleOAuthClient(config)
      .exchangeCode("4/0Aexpired")
      .catch((error: unknown) => classifyUnknown(error));

    expect(failure).toMatchObject({ kind: GoogleFailureKinds.RECONNECT, reason: "invalid_grant" });
  });

  it("never puts the client secret in an error", async () => {
    // The request body carries it, and an error message is the likeliest place
    // for a secret to escape into a log or a Sentry event.
    stubFetch({ status: 401, body: { error: "invalid_client" } });

    const message = await createGoogleOAuthClient(config)
      .exchangeCode("4/0Acode")
      .then(() => "", (error: Error) => `${error.message} ${JSON.stringify(error)}`);

    expect(message).not.toContain(config.clientSecret);
  });

  it("reports a transport failure with no status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(Object.assign(new Error("boom"), { code: "ECONNRESET" }))),
    );

    const failure = await createGoogleOAuthClient(config)
      .exchangeCode("4/0Acode")
      .catch((error: unknown) => classifyUnknown(error));

    expect(failure).toMatchObject({ kind: GoogleFailureKinds.RETRY, reason: "ECONNRESET" });
  });
});

describe("fetchAccountEmail", () => {
  it("returns the connected account's address", async () => {
    // Not the user's login: a provider may well connect a different account,
    // and this is what makes reconnecting an upsert rather than a duplicate.
    stubFetch({ body: { email: "anna.personal@gmail.com", email_verified: true } });

    await expect(createGoogleOAuthClient(config).fetchAccountEmail("ya29.x")).resolves.toBe(
      "anna.personal@gmail.com",
    );
  });

  it("refuses a response with no email rather than storing an empty one", async () => {
    stubFetch({ body: { sub: "12345" } });

    await expect(createGoogleOAuthClient(config).fetchAccountEmail("ya29.x")).rejects.toThrow(
      /no account email/u,
    );
  });
});

describe("revoke", () => {
  it("does not throw when Google refuses", async () => {
    // Best effort by design: the user asked to be disconnected, and a failed
    // revoke must not block that. They can always revoke from Google directly.
    stubFetch({ status: 400, body: { error: "invalid_token" } });

    await expect(createGoogleOAuthClient(config).revoke("1//0gRefresh")).resolves.toBeUndefined();
  });
});

describe("errorFrom", () => {
  it("reads the token endpoint's reason", () => {
    expect(errorFrom(400, { error: "invalid_grant" }).signal.reason).toBe("invalid_grant");
  });

  it("reads the Calendar API's nested reason", () => {
    // Two endpoints, two shapes. Both are handled here so callers do not have to
    // know which one they were talking to.
    const error = errorFrom(403, {
      error: {
        errors: [{ reason: "rateLimitExceeded", message: "Rate Limit Exceeded" }],
        message: "Rate Limit Exceeded",
      },
    });

    expect(error.signal).toMatchObject({ status: 403, reason: "rateLimitExceeded" });
  });

  it("survives a body that is not JSON at all", () => {
    // A 502 from a proxy in front of Google returns HTML.
    expect(errorFrom(502, null).signal).toMatchObject({ status: 502 });
    expect(classifyUnknown(errorFrom(502, null)).kind).toBe(GoogleFailureKinds.RETRY);
  });
});
