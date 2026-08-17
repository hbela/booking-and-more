/**
 * What one calendar connection's panel should say, and what it should offer.
 * docs/phase-6-google-calendar-part-1.md §7.9.
 *
 * ## Why this is a separate, pure module
 *
 * The screen has to collapse four independent facts — the integration's status,
 * whether a calendar has been chosen, how many events are queued, and how many
 * are parked — into **one** thing to say and **one** thing to offer. Written
 * inline that becomes a ladder of ternaries in JSX where the ordering is invisible
 * and untestable, and the ordering is the part that matters:
 *
 * A connection that needs re-consent will usually *also* have parked events,
 * because the grant died and the rows failed. Showing "sync failed — retry"
 * there offers a button that cannot work: requeued rows are handed straight back
 * by the processor, and the provider spends their afternoon pressing it. So
 * `needsReconnect` is decided **before** `failed`, and the same reasoning puts
 * `noCalendar` above both — an integration with nothing selected has no failures
 * to report and nothing to retry, only a choice nobody has made yet.
 *
 * Deciding that here means it is asserted in a unit test rather than discovered
 * by a provider.
 */

export interface SyncCounts {
  pending: number;
  syncing: number;
  synced: number;
  failed: number;
}

export interface CalendarIntegrationView {
  id: string;
  accountEmail: string;
  providerId: string | null;
  providerName: string | null;
  status: "ACTIVE" | "NEEDS_RECONNECT" | "DISCONNECTED";
  lastError: string | null;
  connectedAt: string;
  scopes: string[];
  calendars: {
    id: string;
    externalCalendarId: string;
    calendarName: string | null;
    writeBookings: boolean;
    readBusy: boolean;
    active: boolean;
  }[];
  sync: SyncCounts;
}

export type IntegrationHealth =
  /** The user disconnected it. Nothing is wrong and nothing is pending. */
  | { kind: "disconnected" }
  /** The grant is gone. Only a human can fix it, and only by re-consenting. */
  | { kind: "needsReconnect"; lastError: string | null }
  /** Connected, but no calendar chosen — so nothing is being written anywhere. */
  | { kind: "noCalendar" }
  /** tech-impl §25.6's "Calendar sync failed / Retry scheduled". */
  | { kind: "failed"; failed: number }
  /** Work in flight: the backfill draining, or a booking on its way. */
  | { kind: "syncing"; queued: number }
  /** Everything we wanted Google to say, Google says. */
  | { kind: "healthy"; synced: number };

/** The calendar this provider's bookings are written to, if one is chosen. */
export function writeCalendarOf(
  integration: Pick<CalendarIntegrationView, "calendars">,
): CalendarIntegrationView["calendars"][number] | undefined {
  return integration.calendars.find((calendar) => calendar.active && calendar.writeBookings);
}

/**
 * **Order is the whole content of this function.** See the note at the top.
 */
export function resolveIntegrationHealth(
  integration: Pick<CalendarIntegrationView, "status" | "lastError" | "calendars" | "sync">,
): IntegrationHealth {
  if (integration.status === "DISCONNECTED") return { kind: "disconnected" };

  if (integration.status === "NEEDS_RECONNECT") {
    return { kind: "needsReconnect", lastError: integration.lastError };
  }

  if (writeCalendarOf(integration) === undefined) return { kind: "noCalendar" };

  if (integration.sync.failed > 0) return { kind: "failed", failed: integration.sync.failed };

  const queued = integration.sync.pending + integration.sync.syncing;
  if (queued > 0) return { kind: "syncing", queued };

  return { kind: "healthy", synced: integration.sync.synced };
}

/** The chip's colour. The word beside it is what actually carries the meaning. */
export function healthTone(
  health: IntegrationHealth,
): "neutral" | "info" | "success" | "warning" | "danger" {
  switch (health.kind) {
    case "disconnected":
      return "neutral";
    case "needsReconnect":
      return "danger";
    case "noCalendar":
      return "warning";
    case "failed":
      return "danger";
    case "syncing":
      return "info";
    case "healthy":
      return "success";
  }
}

/**
 * Whether the Retry button is worth showing.
 *
 * Only when something is actually parked **and** the connection could act on a
 * retry. `POST /sync` refuses a non-ACTIVE integration with
 * `CALENDAR_INTEGRATION_INACTIVE` anyway, so offering it there would be a button
 * whose only outcome is an error message.
 */
export function canRetry(health: IntegrationHealth): boolean {
  return health.kind === "failed";
}

/**
 * Outcomes the OAuth callback can hand back in `?calendar=`.
 *
 * Mirrors `CalendarCallbackOutcomes` in the API by value. They are two lists
 * because the web app does not depend on the API's source — but an unknown value
 * must render *something*, so {@link parseCallbackOutcome} narrows to a known
 * key or to `unknown`, and never interpolates a query parameter into the page.
 */
export const CALLBACK_OUTCOMES = [
  "connected",
  "access_denied",
  "invalid_state",
  "session_required",
  "session_mismatch",
  "exchange_failed",
  "missing_scope",
  "no_refresh_token",
  "provider_gone",
] as const;

export type CallbackOutcome = (typeof CALLBACK_OUTCOMES)[number];

/**
 * A `?calendar=` value we are willing to render, or `null` for none at all.
 *
 * `"unknown"` rather than passing the raw value through: the callback's query
 * string is attacker-supplied in the sense that anyone can type it, and a
 * message keyed off it would otherwise put arbitrary text on a signed-in
 * screen — a phishing surface, and the reason this narrows rather than
 * interpolates.
 */
export function parseCallbackOutcome(value: string | null): CallbackOutcome | "unknown" | null {
  if (value === null || value === "") return null;

  return (CALLBACK_OUTCOMES as readonly string[]).includes(value)
    ? (value as CallbackOutcome)
    : "unknown";
}

/** Whether that outcome is worth a green message or a red one. */
export function isSuccessOutcome(outcome: CallbackOutcome | "unknown"): boolean {
  return outcome === "connected";
}
