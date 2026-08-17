import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { can, canManageIntegration, Permissions } from "@bam/auth";
import { commonErrorResponses, ForbiddenError, idSchema } from "@bam/contracts";
import type { GoogleCalendarClient, GoogleOAuthClient } from "@bam/google-calendar";

import {
  IntegrationService,
  type GoogleCalendarConfig,
  type IntegrationState,
} from "./integration.service.js";
import {
  calendarsResponseSchema,
  callbackQuerySchema,
  connectBodySchema,
  connectResponseSchema,
  disconnectResponseSchema,
  integrationsResponseSchema,
  selectCalendarBodySchema,
  selectCalendarResponseSchema,
  syncResponseSchema,
  type calendarMappingSchema,
} from "./integration.schemas.js";

/**
 * Connecting a Google account to a provider's diary. PRD §19.4.
 * docs/phase-6-google-calendar-part-1.md §3.
 *
 * ## Three deviations from §19.4, all deliberate
 *
 * **`POST /connect`, not `GET`.** The route mints a single-use state row, which
 * makes a `GET` state-changing — a link preview, a prefetch or a crawler would
 * each burn one. `POST /v1/billing/portal` set exactly this precedent for
 * exactly this reason.
 *
 * **`DELETE /google/:integrationId`, not `DELETE /google`.** §19.4's path
 * addresses *the* integration, and a tenant may hold several: the unique key is
 * `(tenantId, providerType, accountEmail)`, so two providers connecting their own
 * accounts is the ordinary case rather than an edge one.
 *
 * **The callback answers a redirect, never JSON.** It is reached by a person's
 * browser being handed back by Google, so an error envelope would render as a
 * blob of JSON in the address bar. Every outcome — including refusal — is a 302
 * to the integrations screen carrying a short reason the web app translates.
 *
 * ## Where the permission is asked
 *
 * `INTEGRATION_MANAGE_ALL` / `_OWN`, via `canManageIntegration`, in the handler
 * rather than in a guard: the answer depends on *which* provider is in the
 * request, which a preHandler cannot see (rule 10, same split as
 * `availability.routes.ts`).
 *
 * The callback is the exception and holds no permission check at all. It cannot
 * — it arrives with no tenant header and nothing but a state value — so the
 * authorization it relies on is the one already performed when the state row was
 * created, carried by a secret only that browser holds.
 */

export interface IntegrationRoutesOptions {
  appBaseUrl: string;
  stateTtlMinutes: number;
  backfillLimit: number;
  /** Absent when the platform has no Google credentials; every route 503s. */
  google?: GoogleCalendarConfig | undefined;
  /** The network layer for `google`. Replaced wholesale by the test suite. */
  googleOAuthClient?: GoogleOAuthClient | undefined;
  googleCalendarClient?: GoogleCalendarClient | undefined;
}

export const integrationRoutes: FastifyPluginAsyncZod<IntegrationRoutesOptions> = async (
  app,
  options,
) => {
  const service = new IntegrationService(app.prisma, {
    appBaseUrl: options.appBaseUrl,
    stateTtlMinutes: options.stateTtlMinutes,
    backfillLimit: options.backfillLimit,
    google: options.google,
    oauth: options.googleOAuthClient,
    calendar: options.googleCalendarClient,
  });

  const configured = options.google !== undefined;

  function toMappingResponse(mapping: {
    id: string;
    externalCalendarId: string;
    calendarName: string | null;
    writeBookings: boolean;
    readBusy: boolean;
    active: boolean;
  }): z.infer<typeof calendarMappingSchema> {
    return {
      id: mapping.id,
      externalCalendarId: mapping.externalCalendarId,
      calendarName: mapping.calendarName,
      writeBookings: mapping.writeBookings,
      readBusy: mapping.readBusy,
      active: mapping.active,
    };
  }

  function toStateResponse(state: IntegrationState) {
    const { integration } = state;

    return {
      id: integration.id,
      accountEmail: integration.accountEmail,
      providerId: integration.providerId,
      providerName: integration.provider?.displayName ?? null,
      status: integration.status,
      lastError: integration.lastError,
      connectedAt: integration.connectedAt.toISOString(),
      scopes: integration.scopes,
      calendars: integration.mappings.map(toMappingResponse),
      sync: state.sync,
    };
  }

  /**
   * 403 unless the actor may attach a calendar to this diary.
   *
   * A tenant-wide integration (`providerId === null`) demands the `:all`
   * permission: there is no diary for a provider to claim as their own, so the
   * `:own` half has nothing to match against and must not be a way in.
   */
  function assertMayManage(
    request: { tenant?: { id: string }; actor?: unknown },
    providerId: string | null,
  ): void {
    const tenantId = request.tenant!.id;
    const actor = request.actor as Parameters<typeof canManageIntegration>[0];

    const allowed =
      providerId === null
        ? can(actor, tenantId, Permissions.INTEGRATION_MANAGE_ALL)
        : canManageIntegration(actor, tenantId, providerId);

    if (!allowed) {
      throw new ForbiddenError("You do not have permission to manage this calendar connection.");
    }
  }

  /** May the actor manage this connection at all? Used to filter the read. */
  function mayManage(
    request: { tenant?: { id: string }; actor?: unknown },
    providerId: string | null,
  ): boolean {
    const tenantId = request.tenant!.id;
    const actor = request.actor as Parameters<typeof canManageIntegration>[0];

    return providerId === null
      ? can(actor, tenantId, Permissions.INTEGRATION_MANAGE_ALL)
      : canManageIntegration(actor, tenantId, providerId);
  }

  // --- What the integrations screen renders ---------------------------------
  //
  // Not in PRD §19.4, which has no route for reading our own state (record §3.2).
  // The health panel needs one, and inferring it from a failed `GET /calendars`
  // would mean calling Google to find out whether we are connected to Google.
  app.get(
    "/google",
    {
      preHandler: [app.requireTenant],
      schema: {
        tags: ["integrations"],
        summary: "Connected calendar accounts, and how their sync is going",
        description:
          "Lists the Google accounts this organization has connected, the calendars each writes to, and the pending/failed event counts behind tech-impl §25.6's dashboard. A provider sees their own connection; an administrator sees every one. `configured: false` means the platform has no Google credentials at all, which is a different message from an empty list.",
        response: { 200: integrationsResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const states = await service.listState(request.tenant!.id);

      return {
        configured,
        // Filtered rather than refused: a provider asking for the screen should
        // get the screen, showing what is theirs. A 403 would be right for one
        // connection and wrong for the page.
        integrations: states
          .filter((state) => mayManage(request, state.integration.providerId))
          .map(toStateResponse),
      };
    },
  );

  // --- Start the handshake --------------------------------------------------
  app.post(
    "/google/connect",
    {
      // Membership and writability only; whose diary it is is settled below,
      // where the provider id is known.
      preHandler: [app.requireWritableTenant, app.requireTenant],
      schema: {
        tags: ["integrations"],
        summary: "Begin connecting a Google account to a provider's diary",
        description:
          "Creates a single-use, fifteen-minute handshake and returns Google's consent URL. Navigate the top-level window there — Google refuses to render inside an iframe. POST rather than GET because it writes: a prefetched GET would burn a handshake nobody started. 503 when this deployment has no Google credentials.",
        body: connectBodySchema,
        response: { 201: connectResponseSchema, ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const tenantId = request.tenant!.id;
      const user = request.user!;
      const { providerId, returnPath } = request.body;

      assertMayManage(request, providerId);

      const started = await service.startConnect({
        tenantId,
        userId: user.id,
        providerId,
        returnPath,
        // Pre-fills Google's account chooser with the address they signed in
        // with. A convenience only: they may pick any account, and the callback
        // records whichever one they actually chose.
        loginHint: user.email,
        now: new Date(),
      });

      request.audit({
        action: "calendar.connect_started",
        entityType: "Provider",
        entityId: providerId,
        tenantId,
        // No state value and no URL: the URL carries the state secret, and an
        // audit row is read by more people, for longer, than the person who
        // asked for it (rule 6).
        after: { providerType: "GOOGLE" },
      });

      return reply.status(201).send({
        authorizationUrl: started.authorizationUrl,
        expiresAt: started.expiresAt.toISOString(),
      });
    },
  );

  // --- Google hands the browser back ----------------------------------------
  //
  // No preHandler at all. There is no tenant header to resolve — Google
  // redirects a bare browser here — and no permission to assert beyond the one
  // already asserted when the state row was made. The session cookie *is* read,
  // and matched against the row, inside the service.
  app.get(
    "/google/callback",
    {
      schema: {
        tags: ["integrations"],
        summary: "Google's OAuth redirect target",
        description:
          "Validates and burns the handshake, exchanges the authorization code, seals the tokens and redirects to the integrations screen. Always answers 302, including on failure: this URL is opened by a browser, so the outcome travels as a `?calendar=` reason the web app renders in the reader's language. Not called directly by any client.",
        querystring: callbackQuerySchema,
        response: {
          302: z.null(),
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const result = await service.completeConnect({
        state: request.query.state,
        code: request.query.code,
        error: request.query.error,
        sessionUserId: request.user?.id,
        now: new Date(),
      });

      if (result.audit) {
        request.audit({
          action: result.audit.action,
          entityType: "CalendarIntegration",
          entityId: result.audit.integrationId,
          tenantId: result.audit.tenantId,
          after: { accountEmail: result.audit.accountEmail, providerType: "GOOGLE" },
        });
      }

      // The outcome only. No code, no token, no state — tech-impl §25.2 names
      // all three, and this is the line most likely to be reached for during an
      // incident.
      request.log.info({ outcome: result.outcome }, "google calendar callback");

      return reply.redirect(result.redirectTo, 302);
    },
  );

  // --- Choosing a calendar --------------------------------------------------
  app.get(
    "/google/:integrationId/calendars",
    {
      preHandler: [app.requireTenant],
      schema: {
        tags: ["integrations"],
        summary: "Calendars this Google account can write to",
        description:
          "Asks Google, live. Only calendars the account holds writer or owner access on are returned — a read-only calendar would accept the selection and then refuse every event with a 403 the provider could not act on. Refreshes the stored access token if it is close to expiring. 409 when the connection needs reconnecting; 503 when Google is unreachable.",
        params: z.object({ integrationId: idSchema }),
        response: { 200: calendarsResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { integrationId } = request.params;

      const integration = await service.requireIntegration({ tenantId, integrationId });
      assertMayManage(request, integration.providerId);

      const items = await service.listCalendars({ tenantId, integrationId, now: new Date() });

      return { items };
    },
  );

  app.post(
    "/google/:integrationId/calendars/select",
    {
      preHandler: [app.requireWritableTenant, app.requireTenant],
      schema: {
        tags: ["integrations"],
        summary: "Send this provider's bookings to one calendar",
        description:
          "Selects the calendar that receives this provider's appointments and queues the upcoming ones it has missed, soonest first and capped. Nothing is written to Google by this request — the rows are queued and the worker drains them. Selecting a different calendar leaves events already created where they are: they are real appointments, and the response names the calendar that was replaced so the screen can say so.",
        params: z.object({ integrationId: idSchema }),
        body: selectCalendarBodySchema,
        response: { 200: selectCalendarResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { integrationId } = request.params;

      const integration = await service.requireIntegration({ tenantId, integrationId });
      assertMayManage(request, integration.providerId);

      const result = await service.selectCalendar({
        tenantId,
        integrationId,
        externalCalendarId: request.body.externalCalendarId,
        calendarName: request.body.calendarName,
        now: new Date(),
      });

      request.audit({
        action: "calendar.calendar_selected",
        entityType: "CalendarMapping",
        entityId: result.mapping.id,
        tenantId,
        before:
          result.replacedCalendarId === null
            ? undefined
            : { externalCalendarId: result.replacedCalendarId },
        after: {
          externalCalendarId: result.mapping.externalCalendarId,
          providerId: result.mapping.providerId,
          backfilled: result.backfilled,
        },
      });

      return {
        mapping: toMappingResponse(result.mapping),
        backfilled: result.backfilled,
        replacedCalendarId: result.replacedCalendarId,
      };
    },
  );

  // --- Retry what failed ----------------------------------------------------
  app.post(
    "/google/:integrationId/sync",
    {
      preHandler: [app.requireWritableTenant, app.requireTenant],
      schema: {
        tags: ["integrations"],
        summary: "Retry the events that failed",
        description:
          "Puts every parked event for this connection back in the queue with a fresh attempt budget — the action behind tech-impl §25.6's 'Retry scheduled'. Only FAILED rows are touched: a syncing row may be held by a live worker and a pending one is already queued. Nothing is enqueued here; the worker's sweep picks the rows up.",
        params: z.object({ integrationId: idSchema }),
        response: { 200: syncResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { integrationId } = request.params;

      const integration = await service.requireIntegration({ tenantId, integrationId });
      assertMayManage(request, integration.providerId);

      const result = await service.requestSync({ tenantId, integrationId, now: new Date() });

      request.audit({
        action: "calendar.sync_requested",
        entityType: "CalendarIntegration",
        entityId: integrationId,
        tenantId,
        after: { requeued: result.requeued },
      });

      return result;
    },
  );

  // --- Disconnect -----------------------------------------------------------
  app.delete(
    "/google/:integrationId",
    {
      // Not behind requireWritableTenant. A suspended organization must still be
      // able to withdraw a third party's access to its providers' calendars —
      // that is a right, not a feature, and gating it would leave the one action
      // a worried provider wants unreachable exactly when they want it.
      preHandler: [app.requireTenant],
      schema: {
        tags: ["integrations"],
        summary: "Disconnect a Google account",
        description:
          "Clears the stored tokens, stops every calendar this account was writing to, and asks Google to revoke the grant. Events already created stay in Google: they are real appointments somebody still has to attend. Revocation is best effort — the disconnection is recorded either way, and the response says which happened.",
        params: z.object({ integrationId: idSchema }),
        response: { 200: disconnectResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenantId = request.tenant!.id;
      const { integrationId } = request.params;

      // Read first: the permission question is "whose diary", and only the row
      // knows. A tenant that cannot see it gets the same 404 as one where it
      // does not exist, so the read leaks nothing the check would.
      const integration = await service.requireIntegration({ tenantId, integrationId });
      assertMayManage(request, integration.providerId);

      const result = await service.disconnect({ tenantId, integrationId });

      request.audit({
        action: "calendar.disconnected",
        entityType: "CalendarIntegration",
        entityId: integrationId,
        tenantId,
        before: { status: integration.status, accountEmail: integration.accountEmail },
        after: {
          status: "DISCONNECTED",
          deactivatedCalendars: result.deactivatedCalendars,
          revokedAtGoogle: result.revokedAtGoogle,
        },
      });

      return {
        id: integrationId,
        status: "DISCONNECTED" as const,
        accountEmail: result.accountEmail,
        deactivatedCalendars: result.deactivatedCalendars,
        revokedAtGoogle: result.revokedAtGoogle,
      };
    },
  );
};
