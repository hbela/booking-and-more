import { GoogleApiError } from "./google.errors.js";

/**
 * The Google OAuth endpoints, over `fetch`. tech-impl §25.1.
 *
 * Hand-rolled rather than `googleapis` for the reason recorded in
 * docs/phase-6-google-calendar-part-1.md §2.7: this is three HTTP calls, and an
 * SDK error class flattens exactly the `status` + `reason` pair the classifier
 * needs. The same call `email.provider.ts` made for Resend.
 *
 * **Nothing here logs.** Every function in this file handles either an
 * authorization code or a refresh token, and both are bearer credentials for
 * somebody's calendar.
 */

/**
 * What we ask Google for.
 *
 * `calendar.events` — read and write events on calendars the user grants. Not
 * the broader `calendar` scope, which also allows creating and deleting whole
 * calendars and changing their sharing; we do neither, and a scope you do not
 * need is a scope you have to justify at verification.
 *
 * `calendar.readonly` is what part 2's busy-time reads will want; it is
 * deliberately **not** requested now. Asking for a permission months before
 * using it is exactly what makes a consent screen alarming, and Google's
 * incremental authorization exists so the second ask is cheap.
 *
 * `userinfo.email` is how the callback learns which account was connected —
 * `calendar_integrations.account_email`, which is what the provider sees on the
 * integrations screen and what makes reconnecting an upsert rather than a
 * duplicate.
 *
 * **`calendar.events` is a Google *sensitive* scope.** Until the app is
 * verified it is capped at 100 connected users and shows a warning screen
 * (record §4).
 */
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleTokenSet {
  accessToken: string;
  /**
   * Absent on a re-consent where Google decides we already have one. The caller
   * must keep the stored token in that case rather than overwriting it with
   * null — losing it silently converts a working integration into one that dies
   * at the first access-token expiry, an hour later.
   */
  refreshToken: string | undefined;
  expiresAt: Date;
  /** What Google actually granted, which may be less than was asked for. */
  scopes: string[];
}

/**
 * Where to send the browser.
 *
 * `access_type=offline` plus `prompt=consent` is the combination that
 * guarantees a refresh token. Without `prompt=consent` Google issues one only
 * on the *first* ever consent for this client and user pair — so a provider who
 * disconnects and reconnects gets an access token, no refresh token, and an
 * integration that stops working within the hour. That failure is invisible
 * until it happens, which is why the prompt is forced every time.
 *
 * `include_granted_scopes` lets part 2 add the read scope without discarding
 * this one.
 */
export function buildAuthorizationUrl(
  config: GoogleOAuthConfig,
  args: { state: string; loginHint?: string | undefined },
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GOOGLE_CALENDAR_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: args.state,
  });

  // Pre-fills the account chooser. A convenience only — the user may pick a
  // different account, and the callback records whichever one they chose.
  if (args.loginHint !== undefined && args.loginHint !== "") {
    params.set("login_hint", args.loginHint);
  }

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** The interface the API and worker depend on, so both can be given a fake. */
export interface GoogleOAuthClient {
  exchangeCode(code: string): Promise<GoogleTokenSet>;
  refresh(refreshToken: string): Promise<GoogleTokenSet>;
  /** The address of the account that granted consent. */
  fetchAccountEmail(accessToken: string): Promise<string>;
  /**
   * Best-effort. A revoke that fails must not block a disconnection: the user
   * asked to be disconnected, and they can always revoke from their own Google
   * account settings.
   */
  revoke(token: string): Promise<void>;
}

export function createGoogleOAuthClient(config: GoogleOAuthConfig): GoogleOAuthClient {
  return {
    async exchangeCode(code: string): Promise<GoogleTokenSet> {
      return tokenRequest({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
        code,
      });
    },

    async refresh(refreshToken: string): Promise<GoogleTokenSet> {
      return tokenRequest({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
    },

    async fetchAccountEmail(accessToken: string): Promise<string> {
      const response = await fetch(USERINFO_ENDPOINT, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) throw errorFrom(response.status, payload);

      const email = (payload as { email?: unknown } | null)?.email;

      if (typeof email !== "string" || email === "") {
        // Without it there is no `account_email`, so reconnecting would create a
        // second integration rather than updating this one.
        throw new GoogleApiError("Google returned no account email", {
          status: response.status,
          reason: "invalid",
        });
      }

      return email;
    },

    async revoke(token: string): Promise<void> {
      await fetch(REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      });
    },
  };
}

async function tokenRequest(form: Record<string, string>): Promise<GoogleTokenSet> {
  let response: Response;

  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (error) {
    // No response at all. The message is the transport failure only — `form`
    // holds a client secret and must never reach an error string.
    const code = (error as { code?: string }).code;
    throw new GoogleApiError("Google token request failed", {
      ...(code === undefined ? {} : { code }),
    });
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) throw errorFrom(response.status, payload);

  const body = payload as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  } | null;

  if (!body?.access_token) {
    throw new GoogleApiError("Google returned no access token", {
      status: response.status,
      reason: "invalid",
    });
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    // Google always sends `expires_in`; the fallback of an hour is its documented
    // value and keeps the field non-nullable rather than adding a branch
    // everywhere downstream.
    expiresAt: new Date(Date.now() + (body.expires_in ?? 3_600) * 1_000),
    scopes: body.scope === undefined ? [] : body.scope.split(" ").filter(Boolean),
  };
}

/**
 * Turn a failed response into something the classifier understands.
 *
 * The token endpoint reports its reason as `error` (`invalid_grant`), while the
 * Calendar API uses `error.errors[0].reason` — both are read here so callers do
 * not have to know which endpoint they were talking to.
 */
export function errorFrom(status: number, payload: unknown): GoogleApiError {
  const body = payload as {
    error?: string | { errors?: { reason?: string }[]; message?: string; status?: string };
    error_description?: string;
  } | null;

  const reason =
    typeof body?.error === "string"
      ? body.error
      : (body?.error?.errors?.[0]?.reason ?? body?.error?.status);

  // Google's own message, never the request. A description like "Bad Request"
  // is useless but harmless; the request body would carry a secret.
  const message =
    body?.error_description ??
    (typeof body?.error === "object" ? body.error?.message : undefined) ??
    `Google returned ${String(status)}`;

  return new GoogleApiError(message, { status, ...(reason === undefined ? {} : { reason }) });
}
