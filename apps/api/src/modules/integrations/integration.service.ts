import { createHash, randomBytes } from "node:crypto";
import { openToken, sealToken } from "@bam/crypto";
import type { CalendarIntegration, PrismaClient } from "@bam/db";
import {
  buildAuthorizationUrl,
  classifyUnknown,
  GOOGLE_CALENDAR_SCOPES,
  isAccessTokenStale,
  needsReconnect,
  type GoogleCalendarClient,
  type GoogleCalendarSummary,
  type GoogleOAuthClient,
  type GoogleOAuthConfig,
  type GoogleTokenSet,
} from "@bam/google-calendar";
import {
  buildAppUrl,
  ConflictError,
  ErrorCodes,
  NotFoundError,
  ServiceUnavailableError,
  resolveAppLocale,
} from "@bam/contracts";

import {
  IntegrationRepository,
  type IntegrationWithCalendars,
} from "./integration.repository.js";
import { returnPathSchema } from "./integration.schemas.js";

/**
 * Connecting and disconnecting a Google account.
 * tech-impl §25.1, docs/phase-6-google-calendar-part-1.md §2.5.
 *
 * ## The shape of the callback
 *
 * Every other route in this API answers JSON to a program. This one answers a
 * `302` to a person's browser, because that is who arrives: Google redirects the
 * top-level window here and whatever we send is rendered as a page. So the
 * service returns a **URL and an outcome**, never a thrown error, and the route
 * only sets a header. An error envelope would be a JSON blob in an address bar.
 *
 * That is also why the outcome is a closed union of short reasons rather than a
 * message: it is going into a query string that the integrations screen renders
 * in the reader's own language, and a server-composed English sentence in a URL
 * would be neither translatable nor trustworthy.
 *
 * ## What never appears in a return value here
 *
 * An authorization code, an access token, a refresh token, or the state secret
 * (tech-impl §25.2). Outcomes carry an account email and an integration id and
 * nothing else — the route logs the outcome, and a log line is the likeliest
 * place for a credential to escape.
 */

/** Where the browser lands when nothing better was recorded. */
const DEFAULT_RETURN_PATH = "/dashboard/integrations";

/**
 * Why a handshake ended. Rendered by the web app; never shown raw.
 *
 * `session_required` and `session_mismatch` are separate on purpose even though
 * they redirect identically: the first is a browser that did not send a cookie
 * on a cross-site redirect, the second is a genuine mismatch, and only one of
 * those is worth investigating when it appears in the logs.
 */
export const CalendarCallbackOutcomes = {
  CONNECTED: "connected",
  /** The provider clicked "cancel" on Google's consent screen. */
  ACCESS_DENIED: "access_denied",
  /** Unknown, expired, already used, or missing entirely. */
  INVALID_STATE: "invalid_state",
  SESSION_REQUIRED: "session_required",
  SESSION_MISMATCH: "session_mismatch",
  /** Google refused the code, or could not be reached. */
  EXCHANGE_FAILED: "exchange_failed",
  /** Consent granted, but not the scope that makes this feature work. */
  MISSING_SCOPE: "missing_scope",
  /** Consented without a refresh token, and we have none stored to fall back on. */
  NO_REFRESH_TOKEN: "no_refresh_token",
  /** The provider the flow was started for is gone, or was never this tenant's. */
  PROVIDER_GONE: "provider_gone",
} as const;

export type CalendarCallbackOutcome =
  (typeof CalendarCallbackOutcomes)[keyof typeof CalendarCallbackOutcomes];

export interface CallbackAudit {
  action: "calendar.connected" | "calendar.reconnected" | "calendar.connect_incomplete";
  tenantId: string;
  integrationId: string;
  accountEmail: string;
}

export interface CallbackResult {
  outcome: CalendarCallbackOutcome;
  /** Absolute, already localised, already carrying the outcome. */
  redirectTo: string;
  /** Present only when a row was written. The route records it. */
  audit?: CallbackAudit;
}

export interface GoogleCalendarConfig extends GoogleOAuthConfig {
  /** Parsed at boot by `parseEncryptionKey`, never a hex string at this depth. */
  encryptionKey: Buffer;
}

export interface IntegrationServiceOptions {
  appBaseUrl: string;
  stateTtlMinutes: number;
  /** How many upcoming bookings a newly selected calendar receives. */
  backfillLimit: number;
  /** Absent when the platform has no Google credentials. Every route then 503s. */
  google?: GoogleCalendarConfig | undefined;
  /** The network layer. Absent alongside `google`; injected whole by tests. */
  oauth?: GoogleOAuthClient | undefined;
  /** The Calendar API, likewise. */
  calendar?: GoogleCalendarClient | undefined;
}

/** One connection as the integrations screen reads it. */
export interface IntegrationState {
  integration: IntegrationWithCalendars;
  sync: { pending: number; syncing: number; synced: number; failed: number };
}

export class IntegrationService {
  private readonly repository: IntegrationRepository;

  constructor(
    prisma: PrismaClient,
    private readonly options: IntegrationServiceOptions,
  ) {
    this.repository = new IntegrationRepository(prisma);
  }

  /**
   * Can this API talk to Google at all?
   *
   * Both halves are required and they are configured together: `google` comes
   * from the environment, `oauth` is built from it (or injected by a test). A
   * true answer from one and not the other would mean a route that starts a
   * consent flow it cannot finish.
   */
  isConfigured(): boolean {
    return this.options.google !== undefined && this.options.oauth !== undefined;
  }

  // -------------------------------------------------------------------------
  // Step 1 — start the handshake
  // -------------------------------------------------------------------------

  /**
   * Mint a single-use state row and return where to send the browser.
   *
   * The state value is 32 random bytes; **only its SHA-256 reaches the
   * database**, exactly as an invitation token does. A state row is a much
   * smaller prize than an invitation — it is worth one handshake, for fifteen
   * minutes, in one browser — but the storage discipline is the same one, and
   * having two disciplines for two kinds of single-use secret is how the weaker
   * one ends up on the wrong thing.
   */
  async startConnect(input: {
    tenantId: string;
    userId: string;
    providerId: string;
    returnPath: string | undefined;
    loginHint: string | undefined;
    now: Date;
  }): Promise<{ authorizationUrl: string; expiresAt: Date }> {
    const google = this.requireConfig();

    if (!(await this.repository.providerExists(input))) {
      throw new NotFoundError(
        "That provider does not exist in this organization.",
        ErrorCodes.PROVIDER_NOT_FOUND,
      );
    }

    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      input.now.getTime() + this.options.stateTtlMinutes * 60 * 1_000,
    );

    await this.repository.createOauthState({
      tenantId: input.tenantId,
      userId: input.userId,
      stateHash: hashState(state),
      providerId: input.providerId,
      returnPath: input.returnPath ?? null,
      expiresAt,
    });

    return {
      authorizationUrl: buildAuthorizationUrl(google, {
        state,
        ...(input.loginHint === undefined ? {} : { loginHint: input.loginHint }),
      }),
      expiresAt,
    };
  }

  // -------------------------------------------------------------------------
  // Step 2 — finish it
  // -------------------------------------------------------------------------

  /**
   * Validate the state, exchange the code, seal what comes back.
   *
   * Ordered so that the irreversible step happens as late as possible and the
   * cheap refusals happen first. The state is burned *before* the code is
   * exchanged, though — a code is single-use at Google's end anyway, and burning
   * late would leave a window in which two callbacks both pass validation.
   */
  async completeConnect(input: {
    state: string | undefined;
    code: string | undefined;
    error: string | undefined;
    sessionUserId: string | undefined;
    now: Date;
  }): Promise<CallbackResult> {
    const { google, oauth } = this.requireClient();

    if (input.state === undefined || input.state === "") {
      return this.fail(CalendarCallbackOutcomes.INVALID_STATE, null);
    }

    const claimed = await this.repository.claimOauthState(hashState(input.state), input.now);

    // Unknown, expired, or already burned — the three are one answer on purpose.
    // Telling a caller which would let them probe for live handshakes.
    if (claimed === null) {
      return this.fail(CalendarCallbackOutcomes.INVALID_STATE, null);
    }

    const context = {
      tenantId: claimed.tenantId,
      returnPath: claimed.returnPath,
    };

    // Google says the user declined. Nothing is wrong and nothing is stored;
    // the state is already burned, so a second thought means a second click.
    if (input.error !== undefined && input.error !== "") {
      return this.fail(CalendarCallbackOutcomes.ACCESS_DENIED, context);
    }

    if (input.sessionUserId === undefined) {
      return this.fail(CalendarCallbackOutcomes.SESSION_REQUIRED, context);
    }

    // The handshake belongs to the session that started it. Defence in depth
    // rather than the primary control — the state secret already is that — but
    // it is what stops a callback URL copied out of a shared machine's history
    // from attaching an account under somebody else's signed-in session.
    if (input.sessionUserId !== claimed.userId) {
      return this.fail(CalendarCallbackOutcomes.SESSION_MISMATCH, context);
    }

    if (input.code === undefined || input.code === "") {
      return this.fail(CalendarCallbackOutcomes.INVALID_STATE, context);
    }

    // Between starting the flow and finishing it, somebody may have archived the
    // provider. Checked again here because a mapping needs a live diary.
    if (
      claimed.providerId !== null &&
      !(await this.repository.providerExists({
        tenantId: claimed.tenantId,
        providerId: claimed.providerId,
      }))
    ) {
      return this.fail(CalendarCallbackOutcomes.PROVIDER_GONE, context);
    }

    let tokens: GoogleTokenSet;
    let accountEmail: string;

    try {
      tokens = await oauth.exchangeCode(input.code);
      accountEmail = await oauth.fetchAccountEmail(tokens.accessToken);
    } catch {
      // Deliberately no `error` in scope beyond this line. The request body of a
      // token exchange carries the client secret, and an exception from that
      // call is the likeliest thing anybody would think to log whole.
      return this.fail(CalendarCallbackOutcomes.EXCHANGE_FAILED, context);
    }

    const existed = await this.repository.integrationExists({
      tenantId: claimed.tenantId,
      accountEmail,
    });

    // A refresh token is what makes this survive the hour. `prompt=consent`
    // forces one on every connect, so its absence means something unexpected —
    // and on a *first* connection there is nothing stored to fall back on, so
    // storing the rest would create an integration that works until lunchtime.
    if (tokens.refreshToken === undefined && !existed) {
      return this.fail(CalendarCallbackOutcomes.NO_REFRESH_TOKEN, context);
    }

    // Google grants scope by scope, and a consent screen has checkboxes. Without
    // `calendar.events` nothing here can write, so the integration is recorded —
    // the granted scopes are what make this diagnosable as itself rather than as
    // a 403 three days later — but recorded as NEEDS_RECONNECT, because a status
    // of ACTIVE would be a claim that it can do work.
    const missingScope = GOOGLE_CALENDAR_SCOPES.find((scope) => !tokens.scopes.includes(scope));
    const usable = missingScope === undefined;

    const integration = await this.repository.upsertIntegration({
      tenantId: claimed.tenantId,
      userId: claimed.userId,
      providerId: claimed.providerId,
      accountEmail,
      sealedAccessToken: sealToken(tokens.accessToken, google.encryptionKey),
      sealedRefreshToken:
        tokens.refreshToken === undefined
          ? undefined
          : sealToken(tokens.refreshToken, google.encryptionKey),
      accessTokenExpiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      status: usable ? "ACTIVE" : "NEEDS_RECONNECT",
      lastError: usable ? null : `Google did not grant ${missingScope}`,
      now: input.now,
    });

    const audit: CallbackAudit = {
      action: usable
        ? existed
          ? "calendar.reconnected"
          : "calendar.connected"
        : "calendar.connect_incomplete",
      tenantId: claimed.tenantId,
      integrationId: integration.id,
      accountEmail,
    };

    if (!usable) {
      return { ...this.fail(CalendarCallbackOutcomes.MISSING_SCOPE, context), audit };
    }

    return {
      outcome: CalendarCallbackOutcomes.CONNECTED,
      redirectTo: await this.redirect(CalendarCallbackOutcomes.CONNECTED, context, integration.id),
      audit,
    };
  }

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------

  /** Read one integration, or 404. Used by the route to find out whose diary it is. */
  async requireIntegration(input: {
    tenantId: string;
    integrationId: string;
  }): Promise<CalendarIntegration> {
    const integration = await this.repository.findIntegration(input);

    if (integration === null) {
      // The same answer a tenant that cannot see it would get (rule 5).
      throw new NotFoundError("That calendar connection does not exist.");
    }

    return integration;
  }

  /**
   * Forget the credentials, stop the calendars, tell Google.
   *
   * Revocation is **best effort and last**. The user asked to be disconnected;
   * a Google outage must not be able to refuse that, and they can always revoke
   * from their own account settings. Attempted before the local write only in
   * the sense that the token has to be read first — the local write is what the
   * response reports.
   */
  async disconnect(input: {
    tenantId: string;
    integrationId: string;
  }): Promise<{ deactivatedCalendars: number; revokedAtGoogle: boolean; accountEmail: string }> {
    const integration = await this.requireIntegration(input);
    const revokedAtGoogle = await this.revokeQuietly(integration.sealedRefreshToken);

    const { deactivatedCalendars } = await this.repository.markDisconnected(input);

    return {
      deactivatedCalendars,
      revokedAtGoogle,
      accountEmail: integration.accountEmail,
    };
  }

  // -------------------------------------------------------------------------
  // Reading state, choosing a calendar, retrying (step 6)
  // -------------------------------------------------------------------------

  /**
   * Every connection this tenant holds, each with its event counts.
   *
   * Deliberately not filtered here. *Which* of them the caller may see depends
   * on the provider each one is attached to, and that is an authorization
   * question the route answers with `canManageIntegration` — the same split
   * every other `:own` permission in this codebase uses (rule 10).
   */
  async listState(tenantId: string): Promise<IntegrationState[]> {
    const integrations = await this.repository.listIntegrations(tenantId);

    const counts = await this.repository.countSyncStates(
      tenantId,
      integrations.flatMap((integration) => integration.mappings.map((mapping) => mapping.id)),
    );

    return integrations.map((integration) => {
      const totals = { pending: 0, syncing: 0, synced: 0, failed: 0 };

      for (const mapping of integration.mappings) {
        const perMapping = counts.get(mapping.id);
        if (perMapping === undefined) continue;

        totals.pending += perMapping.PENDING;
        totals.syncing += perMapping.SYNCING;
        totals.synced += perMapping.SYNCED;
        totals.failed += perMapping.FAILED;
      }

      return { integration, sync: totals };
    });
  }

  /**
   * The calendars this account can write to.
   *
   * `minAccessRole=writer` is applied by the client, so a calendar somebody has
   * merely been shown never reaches the picker — offering one produces a 403 the
   * provider cannot act on and cannot understand.
   */
  async listCalendars(input: {
    tenantId: string;
    integrationId: string;
    now: Date;
  }): Promise<(GoogleCalendarSummary & { selected: boolean })[]> {
    const { calendar } = this.requireCalendar();
    const integration = await this.requireActiveIntegration(input);

    const accessToken = await this.accessTokenFor(integration, input.now);

    let calendars: GoogleCalendarSummary[];
    try {
      calendars = await calendar.listCalendars(accessToken);
    } catch (error) {
      throw await this.translateGoogleFailure(integration, error);
    }

    const selected = new Set(
      integration.mappings
        .filter((mapping) => mapping.active && mapping.writeBookings)
        .map((mapping) => mapping.externalCalendarId),
    );

    return calendars.map((entry) => ({ ...entry, selected: selected.has(entry.id) }));
  }

  /**
   * Point this provider's bookings at one calendar, and copy in what it missed.
   *
   * The backfill is inside the same call rather than deferred, because an
   * integration that shows an empty calendar on the day you connect it looks
   * broken — but it only *queues* rows. Nothing is written to Google here: the
   * API owns no queue and makes no calendar writes, and the sweep drains what
   * this leaves behind (§2.2).
   */
  async selectCalendar(input: {
    tenantId: string;
    integrationId: string;
    externalCalendarId: string;
    calendarName: string | undefined;
    now: Date;
  }) {
    const integration = await this.requireActiveIntegration(input);

    if (integration.providerId === null) {
      // A tenant-wide connection has no diary to mirror. Reachable only if a
      // provider is archived between connecting and selecting.
      throw new ConflictError(
        ErrorCodes.CALENDAR_INTEGRATION_INACTIVE,
        "This connection is not attached to a provider, so there is no diary to write.",
      );
    }

    const { mapping, replacedCalendarId } = await this.repository.selectWriteCalendar({
      tenantId: input.tenantId,
      integrationId: input.integrationId,
      providerId: integration.providerId,
      externalCalendarId: input.externalCalendarId,
      calendarName: input.calendarName ?? null,
    });

    const backfilled = await this.repository.backfillBookings({
      tenantId: input.tenantId,
      providerId: integration.providerId,
      calendarMappingId: mapping.id,
      limit: this.options.backfillLimit,
      now: input.now,
    });

    return { mapping, backfilled, replacedCalendarId };
  }

  /** Put every parked row for this connection back in the queue. §25.6. */
  async requestSync(input: {
    tenantId: string;
    integrationId: string;
    now: Date;
  }): Promise<{ requeued: number }> {
    await this.requireActiveIntegration(input);

    return {
      requeued: await this.repository.requeueFailed(input),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * A usable access token, refreshed and re-sealed if the stored one is stale.
   *
   * The staleness rule is `@bam/google-calendar`'s rather than this file's,
   * because the worker asks the same question with the same five-minute margin
   * and two answers drifting apart would be invisible until a batch of writes
   * failed halfway through.
   *
   * Persisting the refreshed token is the point of doing this here: a client
   * that refreshed silently would leave the database holding a token it had
   * already replaced, and the next process to read the row would refresh again.
   */
  private async accessTokenFor(
    integration: IntegrationWithCalendars,
    now: Date,
  ): Promise<string> {
    const { google, oauth } = this.requireClient();

    if (
      integration.sealedAccessToken !== null &&
      !isAccessTokenStale(integration.accessTokenExpiresAt, now)
    ) {
      try {
        return openToken(integration.sealedAccessToken, google.encryptionKey);
      } catch {
        // Sealed under a key that has since been rotated. Falls through to a
        // refresh, which is the honest repair — and if the refresh token is
        // unreadable too, the branch below reports it as needing a human.
      }
    }

    if (integration.sealedRefreshToken === null) {
      await this.repository.markNeedsReconnect({
        integrationId: integration.id,
        reason: "no refresh token stored",
      });
      throw inactive();
    }

    let refreshed: GoogleTokenSet;
    try {
      refreshed = await oauth.refresh(openToken(integration.sealedRefreshToken, google.encryptionKey));
    } catch (error) {
      throw await this.translateGoogleFailure(integration, error);
    }

    await this.repository.storeRefreshedAccessToken({
      integrationId: integration.id,
      sealedAccessToken: sealToken(refreshed.accessToken, google.encryptionKey),
      accessTokenExpiresAt: refreshed.expiresAt,
    });

    return refreshed.accessToken;
  }

  /**
   * Turn a Google failure into an HTTP answer, recording it when it is terminal.
   *
   * The classification is the package's — `403` is not one thing, and
   * `invalid_grant` arrives as a `400` — so the split here is only about what a
   * caller should do: a `RECONNECT` needs a human and is a 409, everything else
   * may well work on the next attempt and is a 503.
   */
  private async translateGoogleFailure(
    integration: { id: string },
    error: unknown,
  ): Promise<Error> {
    const { kind, reason } = classifyUnknown(error);

    if (needsReconnect(kind)) {
      await this.repository.markNeedsReconnect({ integrationId: integration.id, reason });
      return inactive();
    }

    // The reason is Google's short code, never a message we composed and never
    // anything from the request — the classifier guarantees it carries no token.
    return new ServiceUnavailableError(
      "Google Calendar is not answering just now. Please try again shortly.",
      { reason },
    );
  }

  /** Loaded, visible to this tenant, and able to do work. */
  private async requireActiveIntegration(input: {
    tenantId: string;
    integrationId: string;
  }): Promise<IntegrationWithCalendars> {
    const integrations = await this.repository.listIntegrations(input.tenantId);
    const integration = integrations.find((entry) => entry.id === input.integrationId);

    if (integration === undefined) {
      throw new NotFoundError("That calendar connection does not exist.");
    }

    if (integration.status !== "ACTIVE") {
      // 409 rather than 503: this connection specifically needs a human, while
      // 503 would say the platform is misconfigured. The screen gives opposite
      // instructions for the two, so conflating them tells somebody the wrong
      // thing to do.
      throw inactive();
    }

    return integration;
  }

  private requireCalendar(): { calendar: GoogleCalendarClient } {
    this.requireConfig();
    const calendar = this.options.calendar;

    if (calendar === undefined) {
      throw new ServiceUnavailableError(
        "Google Calendar sync is not configured on this deployment.",
      );
    }

    return { calendar };
  }

  private async revokeQuietly(sealed: string | null): Promise<boolean> {
    if (sealed === null) return false;

    const google = this.options.google;
    const oauth = this.options.oauth;
    if (google === undefined || oauth === undefined) return false;

    try {
      await oauth.revoke(openToken(sealed, google.encryptionKey));
      return true;
    } catch {
      // Two different failures collapse here: a token sealed under a key that
      // has since been rotated, and Google refusing. Neither changes what we do,
      // and the response says `revokedAtGoogle: false` rather than claiming a
      // revocation that did not happen.
      return false;
    }
  }

  private requireConfig(): GoogleCalendarConfig {
    const google = this.options.google;

    if (google === undefined) {
      // 503 and not 404: "we have not configured this" and "this does not exist"
      // are different facts, and whoever is reading the logs needs to tell them
      // apart (rule 4, and phase-9-customer-portal.md §2.1's precedent).
      throw new ServiceUnavailableError(
        "Google Calendar sync is not configured on this deployment.",
      );
    }

    return google;
  }

  private requireClient(): { google: GoogleCalendarConfig; oauth: GoogleOAuthClient } {
    const google = this.requireConfig();
    const oauth = this.options.oauth;

    if (oauth === undefined) {
      throw new ServiceUnavailableError(
        "Google Calendar sync is not configured on this deployment.",
      );
    }

    return { google, oauth };
  }

  /** A finished, non-throwing failure: somewhere to land and a reason to render. */
  private fail(
    outcome: CalendarCallbackOutcome,
    context: { tenantId: string; returnPath: string | null } | null,
  ): CallbackResult {
    return {
      outcome,
      redirectTo: this.redirectSync(outcome, context),
    };
  }

  private async redirect(
    outcome: CalendarCallbackOutcome,
    context: { tenantId: string; returnPath: string | null },
    integrationId?: string,
  ): Promise<string> {
    const language = await this.repository.findTenantLanguage(context.tenantId);
    return this.compose(outcome, context.returnPath, language, integrationId);
  }

  /**
   * The same URL without the tenant's language.
   *
   * Failure paths take this one: several of them have no trustworthy tenant at
   * all, and the rest are one redirect away from a screen that will re-render
   * itself in the right language anyway. next-intl's middleware sends an
   * unprefixed path to the reader's own locale, so the cost of not knowing is a
   * redirect and not a wrong-language page.
   */
  private redirectSync(
    outcome: CalendarCallbackOutcome,
    context: { tenantId: string; returnPath: string | null } | null,
  ): string {
    return this.compose(outcome, context?.returnPath ?? null, null);
  }

  private compose(
    outcome: CalendarCallbackOutcome,
    returnPath: string | null,
    language: string | null,
    integrationId?: string,
  ): string {
    // Validated a second time, on the way out. The row was written by a request
    // this schema already guarded, but that guard could be relaxed, the column
    // could be written by something else later, and this is the moment the value
    // becomes a `Location` header (rule: never trust a stored redirect target
    // more than a submitted one).
    const path =
      returnPath !== null && returnPathSchema.safeParse(returnPath).success
        ? returnPath
        : DEFAULT_RETURN_PATH;

    const url = new URL(
      buildAppUrl({
        baseUrl: this.options.appBaseUrl,
        path,
        locale: language ?? resolveAppLocale(null),
      }),
    );

    url.searchParams.set("calendar", outcome);
    if (integrationId !== undefined) url.searchParams.set("integration", integrationId);

    return url.toString();
  }
}

/**
 * The one answer for "this connection cannot do work".
 *
 * A function rather than a constant because an `AppError` carries a stack, and
 * one shared instance would report the first place it was ever thrown.
 */
function inactive(): ConflictError {
  return new ConflictError(
    ErrorCodes.CALENDAR_INTEGRATION_INACTIVE,
    "This Google account needs to be reconnected before it can sync.",
  );
}

/** SHA-256 hex, the same digest the invitation and management tokens use. */
function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}
