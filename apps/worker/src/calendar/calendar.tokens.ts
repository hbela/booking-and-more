import { openToken, sealToken } from "@bam/crypto";
import type { PrismaClient } from "@bam/db";
import {
  classifyUnknown,
  isAccessTokenStale,
  needsReconnect,
  type GoogleOAuthClient,
} from "@bam/google-calendar";

/**
 * A usable access token for one integration, refreshed and re-sealed if needed.
 * docs/phase-6-google-calendar-part-1.md §2.9.
 *
 * The API has a sibling of this in `integration.service.ts`, and the duplication
 * is deliberate: refreshing means **persisting a newly sealed token**, so it
 * belongs to whoever owns the database handle, and the two processes own
 * different ones. What is shared is the only part that must not drift —
 * `isAccessTokenStale`, in `@bam/google-calendar`, so both ask the question with
 * the same five-minute margin.
 *
 * **Nothing here logs.** Every value in scope is a bearer credential for
 * somebody's calendar (tech-impl §25.2).
 */

export interface TokenDeps {
  prisma: PrismaClient;
  oauth: GoogleOAuthClient;
  encryptionKey: Buffer;
}

/** What the caller needs to know when a token cannot be produced. */
export class CalendarGrantError extends Error {
  constructor(public readonly reason: string) {
    super(`google grant unusable: ${reason}`);
    this.name = "CalendarGrantError";
  }
}

export interface SealedIntegration {
  id: string;
  sealedAccessToken: string | null;
  sealedRefreshToken: string | null;
  accessTokenExpiresAt: Date | null;
}

/**
 * Returns a token, or throws {@link CalendarGrantError} having already recorded
 * that the integration needs a human.
 *
 * Recording it here rather than at the call site is what makes the two callers
 * behave identically: whoever discovers a dead grant is the one who knows why,
 * and a caller that has to remember to write it down is a caller that will
 * eventually forget.
 */
export async function resolveAccessToken(
  integration: SealedIntegration,
  now: Date,
  deps: TokenDeps,
): Promise<string> {
  if (
    integration.sealedAccessToken !== null &&
    !isAccessTokenStale(integration.accessTokenExpiresAt, now)
  ) {
    try {
      return openToken(integration.sealedAccessToken, deps.encryptionKey);
    } catch {
      // Sealed under a key that has since been rotated. Falls through to a
      // refresh, which is the honest repair.
    }
  }

  if (integration.sealedRefreshToken === null) {
    await markNeedsReconnect(deps.prisma, integration.id, "no refresh token stored");
    throw new CalendarGrantError("no refresh token stored");
  }

  let refreshToken: string;
  try {
    refreshToken = openToken(integration.sealedRefreshToken, deps.encryptionKey);
  } catch {
    // Unreadable is indistinguishable from revoked as far as anything we can do
    // about it goes, and both need the same human action.
    await markNeedsReconnect(deps.prisma, integration.id, "stored token unreadable");
    throw new CalendarGrantError("stored token unreadable");
  }

  let refreshed;
  try {
    refreshed = await deps.oauth.refresh(refreshToken);
  } catch (error) {
    const { kind, reason } = classifyUnknown(error);

    if (needsReconnect(kind)) {
      await markNeedsReconnect(deps.prisma, integration.id, reason);
      throw new CalendarGrantError(reason);
    }

    // Transient: Google is having a moment. The row stays as it is and the
    // caller backs off — this is emphatically *not* a reason to make somebody
    // reconnect a working integration.
    throw error;
  }

  await deps.prisma.calendarIntegration.update({
    where: { id: integration.id },
    data: {
      sealedAccessToken: sealToken(refreshed.accessToken, deps.encryptionKey),
      accessTokenExpiresAt: refreshed.expiresAt,
      // A success is the only thing that revives a row. Nothing guesses that an
      // integration is healthy again — the same rule phase-9 §3 states for
      // Stripe events, and here for the same reason.
      status: "ACTIVE",
      lastError: null,
    },
  });

  return refreshed.accessToken;
}

async function markNeedsReconnect(
  prisma: PrismaClient,
  integrationId: string,
  reason: string,
): Promise<void> {
  await prisma.calendarIntegration.update({
    where: { id: integrationId },
    data: {
      status: "NEEDS_RECONNECT",
      lastError: reason,
      // Cleared with the status: a stale token left behind means the next caller
      // sees one, uses it, and gets a 401 it has to classify all over again.
      sealedAccessToken: null,
      accessTokenExpiresAt: null,
    },
  });
}
