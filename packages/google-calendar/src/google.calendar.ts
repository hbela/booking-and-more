import { GoogleApiError } from "./google.errors.js";
import { errorFrom } from "./google.oauth.js";
import { buildCancellationPatch, type GoogleEventBody } from "./google.events.js";

/**
 * The Calendar API, over `fetch`. tech-impl §25.5.
 *
 * Three endpoints, one of them twice. Everything about *whether to try again*
 * lives in `google.errors.ts`; this module performs the I/O and reports what
 * happened in the shape the classifier reads.
 *
 * Every call takes an access token as an argument rather than holding one:
 * refreshing is the caller's job because only the caller can persist the new
 * sealed token, and a client that refreshed silently would leave the database
 * holding a token it had already replaced.
 */

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export interface GoogleCalendarSummary {
  id: string;
  summary: string;
  /** Google's own flag for the account's default calendar. */
  primary: boolean;
  /** `owner` / `writer` / `reader` / `freeBusyReader`. */
  accessRole: string;
  timeZone: string | null;
}

export interface GoogleEventResult {
  id: string;
  /** Google's version marker, stored for part 2's change detection. */
  etag: string | null;
  status: string | null;
}

export interface GoogleCalendarClient {
  listCalendars(accessToken: string): Promise<GoogleCalendarSummary[]>;
  /**
   * Create with a caller-supplied id. A `409` means Google already has it —
   * the retry-safety the derived id exists for (record §2.3) — and is reported
   * as `ALREADY_EXISTS` by the classifier rather than thrown as a failure.
   */
  insertEvent(args: {
    accessToken: string;
    calendarId: string;
    eventId: string;
    event: GoogleEventBody;
  }): Promise<GoogleEventResult>;
  patchEvent(args: {
    accessToken: string;
    calendarId: string;
    eventId: string;
    event: Partial<GoogleEventBody>;
  }): Promise<GoogleEventResult>;
  cancelEvent(args: {
    accessToken: string;
    calendarId: string;
    eventId: string;
  }): Promise<GoogleEventResult>;
  /** Used only to recover an etag after a 409. */
  getEvent(args: {
    accessToken: string;
    calendarId: string;
    eventId: string;
  }): Promise<GoogleEventResult>;
}

export function createGoogleCalendarClient(): GoogleCalendarClient {
  return {
    async listCalendars(accessToken: string): Promise<GoogleCalendarSummary[]> {
      // One page of 250 is every calendar anybody has. Not paginating is a
      // deliberate simplification: a provider choosing from more than 250 has a
      // problem this screen would not solve anyway.
      const payload = await request<{
        items?: {
          id?: string;
          summary?: string;
          primary?: boolean;
          accessRole?: string;
          timeZone?: string;
        }[];
      }>(accessToken, `${CALENDAR_API}/users/me/calendarList?maxResults=250&minAccessRole=writer`);

      return (payload.items ?? [])
        .filter((item): item is { id: string } & typeof item => typeof item.id === "string")
        .map((item) => ({
          id: item.id,
          summary: item.summary ?? item.id,
          primary: item.primary === true,
          accessRole: item.accessRole ?? "reader",
          timeZone: item.timeZone ?? null,
        }));
    },

    async insertEvent({ accessToken, calendarId, eventId, event }) {
      // `sendUpdates=none` is load-bearing, not a default. There are no
      // attendees today, so Google would not email anybody — but the day
      // somebody adds one, the failure would be silent mail to a real customer
      // in a language nobody chose (record §2.6).
      return eventResult(
        await request<Record<string, unknown>>(
          accessToken,
          `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`,
          { method: "POST", body: { ...event, id: eventId } },
        ),
      );
    },

    async patchEvent({ accessToken, calendarId, eventId, event }) {
      // PATCH, not PUT: a partial update cannot clobber a field Google added, or
      // one a provider edited by hand that we have no opinion about.
      //
      // No `If-Match`. We are the authority (PRD §9.10), so a stale etag must
      // not refuse our correction — the etag is recorded for part 2's change
      // detection and deliberately not used as a precondition here.
      return eventResult(
        await request<Record<string, unknown>>(
          accessToken,
          eventUrl(calendarId, eventId),
          { method: "PATCH", body: event },
        ),
      );
    },

    async cancelEvent({ accessToken, calendarId, eventId }) {
      return eventResult(
        await request<Record<string, unknown>>(accessToken, eventUrl(calendarId, eventId), {
          method: "PATCH",
          body: buildCancellationPatch(),
        }),
      );
    },

    async getEvent({ accessToken, calendarId, eventId }) {
      return eventResult(
        await request<Record<string, unknown>>(
          accessToken,
          `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        ),
      );
    },
  };
}

function eventUrl(calendarId: string, eventId: string): string {
  return `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`;
}

function eventResult(payload: Record<string, unknown>): GoogleEventResult {
  return {
    id: typeof payload["id"] === "string" ? payload["id"] : "",
    etag: typeof payload["etag"] === "string" ? payload["etag"] : null,
    status: typeof payload["status"] === "string" ? payload["status"] : null,
  };
}

async function request<T>(
  accessToken: string,
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    // No response. The URL is safe to omit and the token must be: the message
    // carries the transport code alone.
    const code = (error as { code?: string }).code;
    throw new GoogleApiError("Google Calendar request failed", {
      ...(code === undefined ? {} : { code }),
    });
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) throw errorFrom(response.status, payload);

  return (payload ?? {}) as T;
}
