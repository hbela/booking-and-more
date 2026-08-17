import type {
  CalendarIntegration,
  CalendarMapping,
  CalendarSyncStatus,
  PrismaClient,
} from "@bam/db";
import { deriveEventId } from "@bam/google-calendar";

/**
 * Every row this module touches. tech-impl §10.14, §25.1.
 *
 * CLAUDE.md rule 5 applies to all of it bar one method, and that exception is
 * the interesting thing in the file — see {@link IntegrationRepository.claimOauthState}.
 */

export interface ClaimedOauthState {
  id: string;
  tenantId: string;
  userId: string;
  providerId: string | null;
  returnPath: string | null;
}

/** One connection, with everything the integrations screen renders about it. */
export interface IntegrationWithCalendars extends CalendarIntegration {
  /** Null when the provider was archived — `SetNull` keeps the connection alive. */
  provider: { displayName: string } | null;
  mappings: CalendarMapping[];
}

export interface UpsertIntegrationInput {
  tenantId: string;
  userId: string;
  providerId: string | null;
  accountEmail: string;
  sealedAccessToken: string;
  /** Undefined leaves whatever is stored alone — see the note at the call site. */
  sealedRefreshToken: string | undefined;
  accessTokenExpiresAt: Date;
  scopes: string[];
  status: "ACTIVE" | "NEEDS_RECONNECT";
  lastError: string | null;
  now: Date;
}

export class IntegrationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createOauthState(input: {
    tenantId: string;
    userId: string;
    stateHash: string;
    providerId: string | null;
    returnPath: string | null;
    expiresAt: Date;
  }): Promise<void> {
    await this.prisma.calendarOauthState.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        stateHash: input.stateHash,
        providerId: input.providerId,
        returnPath: input.returnPath,
        expiresAt: input.expiresAt,
      },
    });
  }

  /**
   * Burn a pending handshake and return what it was for.
   *
   * **The one method here with no `tenantId` parameter, and deliberately.** The
   * callback arrives from Google as a bare browser redirect: no tenant header,
   * no way to send one, and nothing but the `state` value. This row *is* how the
   * tenant is resolved, so requiring the answer as an argument would be circular.
   * `claimInvitation` in the membership service has the same shape for the same
   * reason — whoever is accepting is not a member yet.
   *
   * The burn is an `updateMany` guarded on `consumedAt: null` rather than a read
   * followed by a write, so **PostgreSQL decides who consumed it** (rule 14).
   * Two callbacks racing on one state — a double-clicked consent button, a
   * browser prefetching the redirect — both attempt the update, one sees
   * `count: 1` and the other sees `0`. A `SELECT` first would have both see an
   * unconsumed row.
   *
   * Expiry is part of the same predicate for the same reason: checking it in
   * application code after the read reintroduces the window.
   */
  async claimOauthState(stateHash: string, now: Date): Promise<ClaimedOauthState | null> {
    const claimed = await this.prisma.calendarOauthState.updateMany({
      where: { stateHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });

    if (claimed.count === 0) return null;

    const state = await this.prisma.calendarOauthState.findUnique({
      where: { stateHash },
      select: { id: true, tenantId: true, userId: true, providerId: true, returnPath: true },
    });

    return state;
  }

  /** The organization's language, for building the URL the browser lands on. */
  async findTenantLanguage(tenantId: string): Promise<string | null> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { defaultLanguage: true },
    });

    return tenant?.defaultLanguage ?? null;
  }

  /** Live providers only: a connection cannot be aimed at an archived diary. */
  async providerExists(input: { tenantId: string; providerId: string }): Promise<boolean> {
    const provider = await this.prisma.provider.findFirst({
      where: { id: input.providerId, tenantId: input.tenantId, archivedAt: null },
      select: { id: true },
    });

    return provider !== null;
  }

  async findIntegration(input: {
    tenantId: string;
    integrationId: string;
  }): Promise<CalendarIntegration | null> {
    return this.prisma.calendarIntegration.findFirst({
      where: { id: input.integrationId, tenantId: input.tenantId },
    });
  }

  /**
   * Reconnecting the same Google account updates the row it made last time.
   *
   * The unique key is `(tenantId, providerType, accountEmail)`, so "same
   * account" means the address Google reports — not the address the person
   * signs in to *us* with, which may well differ (§2.5). That is what stops a
   * provider who reconnects twice ending up with three integrations and three
   * copies of every event.
   *
   * `sealedRefreshToken` is written only when Google supplied one. A re-consent
   * that returns just an access token must not blank the stored refresh token:
   * doing so converts a working integration into one that silently stops within
   * the hour, which is the single nastiest failure this flow has.
   */
  async upsertIntegration(input: UpsertIntegrationInput): Promise<CalendarIntegration> {
    const shared = {
      userId: input.userId,
      providerId: input.providerId,
      sealedAccessToken: input.sealedAccessToken,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      scopes: input.scopes,
      status: input.status,
      lastError: input.lastError,
      connectedAt: input.now,
      ...(input.sealedRefreshToken === undefined
        ? {}
        : { sealedRefreshToken: input.sealedRefreshToken }),
    };

    return this.prisma.calendarIntegration.upsert({
      where: {
        tenantId_providerType_accountEmail: {
          tenantId: input.tenantId,
          providerType: "GOOGLE",
          accountEmail: input.accountEmail,
        },
      },
      create: {
        tenantId: input.tenantId,
        providerType: "GOOGLE",
        accountEmail: input.accountEmail,
        ...shared,
      },
      update: shared,
    });
  }

  /** Does this tenant already hold this Google account? Decides connected vs. reconnected. */
  async integrationExists(input: { tenantId: string; accountEmail: string }): Promise<boolean> {
    const existing = await this.prisma.calendarIntegration.findUnique({
      where: {
        tenantId_providerType_accountEmail: {
          tenantId: input.tenantId,
          providerType: "GOOGLE",
          accountEmail: input.accountEmail,
        },
      },
      select: { id: true },
    });

    return existing !== null;
  }

  // -------------------------------------------------------------------------
  // Reading state (step 6)
  // -------------------------------------------------------------------------

  /**
   * Every connection this tenant holds, with its calendars and the provider's
   * name. Ordered so a screen renders identically on every load.
   */
  async listIntegrations(tenantId: string): Promise<IntegrationWithCalendars[]> {
    return this.prisma.calendarIntegration.findMany({
      where: { tenantId },
      include: {
        provider: { select: { displayName: true } },
        mappings: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { connectedAt: "asc" },
    });
  }

  /**
   * How many events are pending, syncing, synced and parked, per calendar.
   *
   * A `groupBy` rather than four counts: this is what §25.6 puts on a dashboard,
   * and asking the same table four times for one screen is how a settings page
   * ends up slower than the booking flow.
   */
  async countSyncStates(
    tenantId: string,
    calendarMappingIds: string[],
  ): Promise<Map<string, Record<CalendarSyncStatus, number>>> {
    const counts = new Map<string, Record<CalendarSyncStatus, number>>();
    if (calendarMappingIds.length === 0) return counts;

    const rows = await this.prisma.calendarEventMapping.groupBy({
      by: ["calendarMappingId", "syncStatus"],
      where: { tenantId, calendarMappingId: { in: calendarMappingIds } },
      _count: { _all: true },
    });

    for (const row of rows) {
      const existing = counts.get(row.calendarMappingId) ?? {
        PENDING: 0,
        SYNCING: 0,
        SYNCED: 0,
        FAILED: 0,
      };

      existing[row.syncStatus] = row._count._all;
      counts.set(row.calendarMappingId, existing);
    }

    return counts;
  }

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  /** Record a refreshed access token. The refresh token itself never changes here. */
  async storeRefreshedAccessToken(input: {
    integrationId: string;
    sealedAccessToken: string;
    accessTokenExpiresAt: Date;
  }): Promise<void> {
    await this.prisma.calendarIntegration.update({
      where: { id: input.integrationId },
      data: {
        sealedAccessToken: input.sealedAccessToken,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        // A successful refresh clears whatever was wrong before, including a
        // NEEDS_RECONNECT set by a failure that has since been fixed at Google's
        // end. The row is only ever revived by a *success*, never by a guess.
        status: "ACTIVE",
        lastError: null,
      },
    });
  }

  /**
   * The grant is gone. Nothing retries from here.
   *
   * The access token is cleared with it: leaving one behind means the next
   * caller sees a token, uses it, and gets a 401 it has to classify all over
   * again — which is how a clear "reconnect me" turns into an intermittent one.
   */
  async markNeedsReconnect(input: { integrationId: string; reason: string }): Promise<void> {
    await this.prisma.calendarIntegration.update({
      where: { id: input.integrationId },
      data: {
        status: "NEEDS_RECONNECT",
        lastError: input.reason,
        sealedAccessToken: null,
        accessTokenExpiresAt: null,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Choosing a calendar
  // -------------------------------------------------------------------------

  /**
   * Point a provider's bookings at one calendar, and only one.
   *
   * The partial unique index `calendar_mappings_one_write_calendar_per_provider`
   * makes "two writing calendars" unrepresentable, so the deactivation below is
   * not a nicety — without it this upsert would be *refused* by PostgreSQL. The
   * index is doing the deciding and this method arranges to satisfy it, which is
   * the right way round (rule 14).
   *
   * The previous mapping is deactivated rather than deleted, because its
   * `calendar_event_mappings` are the only record of what we put in that
   * calendar. Deleting them would lose the ability to ever tidy up, and deleting
   * the events themselves is not on offer — they are real appointments.
   */
  async selectWriteCalendar(input: {
    tenantId: string;
    integrationId: string;
    providerId: string;
    externalCalendarId: string;
    calendarName: string | null;
  }): Promise<{ mapping: CalendarMapping; replacedCalendarId: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.calendarMapping.findFirst({
        where: {
          tenantId: input.tenantId,
          providerId: input.providerId,
          writeBookings: true,
          active: true,
        },
      });

      const unchanged =
        previous !== null &&
        previous.calendarIntegrationId === input.integrationId &&
        previous.externalCalendarId === input.externalCalendarId;

      if (previous !== null && !unchanged) {
        await tx.calendarMapping.update({
          where: { id: previous.id },
          data: { active: false },
        });
      }

      const mapping = await tx.calendarMapping.upsert({
        where: {
          calendarIntegrationId_externalCalendarId: {
            calendarIntegrationId: input.integrationId,
            externalCalendarId: input.externalCalendarId,
          },
        },
        create: {
          tenantId: input.tenantId,
          calendarIntegrationId: input.integrationId,
          providerId: input.providerId,
          externalCalendarId: input.externalCalendarId,
          calendarName: input.calendarName,
          writeBookings: true,
          active: true,
        },
        update: {
          // Re-selecting a calendar that was turned off turns it back on, which
          // is what "resume rather than restart" means for a reconnection.
          providerId: input.providerId,
          calendarName: input.calendarName,
          writeBookings: true,
          active: true,
        },
      });

      return {
        mapping,
        replacedCalendarId: unchanged ? null : (previous?.externalCalendarId ?? null),
      };
    });
  }

  /**
   * Queue the bookings this calendar has missed. tech-impl §25.5.
   *
   * Bounded and **soonest first**: the appointments worth having in a phone are
   * the ones about to happen, and an unbounded backfill on a busy tenant is the
   * one burst this feature generates against Google's per-user rate limit.
   *
   * `createMany` with `skipDuplicates`, never a read followed by a write. The
   * unique index on `(bookingId, calendarMappingId)` is what decides whether a
   * row already exists — re-selecting the same calendar twice is therefore
   * harmless and cheap, and no window exists in which two requests both find
   * nothing and both insert (rule 14).
   *
   * `desiredVersion` is the booking's current `version`, so a reschedule landing
   * between this call and the sweep wins: the processor's guard compares
   * versions and the newer desire supersedes this one.
   */
  async backfillBookings(input: {
    tenantId: string;
    providerId: string;
    calendarMappingId: string;
    limit: number;
    now: Date;
  }): Promise<number> {
    const bookings = await this.prisma.booking.findMany({
      where: {
        tenantId: input.tenantId,
        providerId: input.providerId,
        // Confirmed only (record §3.8): an appointment nobody has accepted
        // appearing in a diary is worse than its absence. Past bookings are
        // skipped for a plainer reason — nobody needs a reminder of a haircut
        // they have already had.
        status: "CONFIRMED",
        startAt: { gt: input.now },
      },
      select: { id: true, version: true },
      orderBy: { startAt: "asc" },
      take: input.limit,
    });

    if (bookings.length === 0) return 0;

    const created = await this.prisma.calendarEventMapping.createMany({
      data: bookings.map((booking) => ({
        tenantId: input.tenantId,
        bookingId: booking.id,
        calendarMappingId: input.calendarMappingId,
        externalEventId: deriveEventId(booking.id, input.calendarMappingId),
        desiredState: "PRESENT" as const,
        desiredVersion: booking.version,
        syncStatus: "PENDING" as const,
      })),
      skipDuplicates: true,
    });

    return created.count;
  }

  /**
   * Put parked rows back in the queue. §25.6's "Retry".
   *
   * `FAILED` only. A `SYNCING` row may be held by a live worker and a `PENDING`
   * one is already queued, so touching either would be a second hand on the same
   * work — the sweep is what reclaims a stale claim, and it knows how long is
   * too long.
   *
   * Nothing is enqueued here. The API owns no queue (the outbox exists precisely
   * so that it does not), and a row that is `PENDING` and due is exactly what the
   * calendar sweep is looking for.
   */
  async requeueFailed(input: {
    tenantId: string;
    integrationId: string;
    now: Date;
  }): Promise<number> {
    const result = await this.prisma.calendarEventMapping.updateMany({
      where: {
        tenantId: input.tenantId,
        syncStatus: "FAILED",
        calendarMapping: { calendarIntegrationId: input.integrationId },
      },
      data: {
        syncStatus: "PENDING",
        // Reset, not decremented: a human has said "try again", and starting
        // from attempt 1 also restarts the backoff at 30 seconds rather than at
        // the hour the eighth attempt had reached.
        attempts: 0,
        nextAttemptAt: input.now,
        claimedAt: null,
        lastError: null,
      },
    });

    return result.count;
  }

  /**
   * Stop an integration doing work, and forget its credentials.
   *
   * Both halves in one transaction: an integration marked DISCONNECTED whose
   * mappings are still `active` would be picked up by the worker's calendar leg,
   * which selects on the mapping.
   *
   * The rows themselves stay (record §5). §34.5 audits disconnection and the
   * trail needs something to point at, a reconnect should resume rather than
   * restart, and the events already in Google are real appointments somebody
   * still has to attend.
   */
  async markDisconnected(input: {
    tenantId: string;
    integrationId: string;
  }): Promise<{ deactivatedCalendars: number }> {
    return this.prisma.$transaction(async (tx) => {
      const mappings = await tx.calendarMapping.updateMany({
        where: {
          tenantId: input.tenantId,
          calendarIntegrationId: input.integrationId,
          active: true,
        },
        data: { active: false },
      });

      await tx.calendarIntegration.update({
        where: { id: input.integrationId },
        data: {
          status: "DISCONNECTED",
          // Cleared, not kept "in case they come back". A refresh token is a
          // standing permission to read somebody's diary; holding one after
          // being told to stop is the thing PRD §9.10 is about.
          sealedAccessToken: null,
          sealedRefreshToken: null,
          accessTokenExpiresAt: null,
          lastError: null,
        },
      });

      return { deactivatedCalendars: mappings.count };
    });
  }
}
