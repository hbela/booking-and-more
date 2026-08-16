import type { Locale } from "./types.js";

/**
 * "Add to Google Calendar", as a URL. tech-impl §27.
 *
 * A pure function of values, so it lives here rather than in the worker — same
 * seam as the templates next door (CLAUDE.md rule 8).
 *
 * ## Why a link and not an `.ics` attachment
 *
 * An `.ics` file is the interoperable answer and would suit Apple Calendar and
 * Outlook too, but it has to be *attached*, and `EmailProvider.send` carries a
 * subject and two bodies and nothing else. Widening that interface — and with it
 * the Resend adapter, the logging provider and every test double — is a larger
 * change than the one that was asked for, and it buys nothing for the customer
 * this is aimed at. A `render?action=TEMPLATE` link is a plain `<a href>` that
 * every email client already renders correctly, and Google's own calendar is
 * where the request pointed. When Apple and Outlook are wanted, the honest move
 * is `.ics` for everyone rather than three vendor links side by side.
 *
 * ## Why the timestamps are UTC
 *
 * The rest of the email prints the appointment in the *clinic's* zone, resolved
 * location → provider → tenant (tech-impl §13.4), because that is the zone the
 * appointment happens in. This URL deliberately does not: an entry in somebody's
 * calendar is an instant, and Google renders instants in whichever zone that
 * calendar is set to. Passing UTC with a trailing `Z` is what makes a customer
 * who books from abroad see the right local time on their own phone. Same
 * distinction as phase-6 §2.7 — a printed time is read in a zone, an event is a
 * moment.
 *
 * Note this is not the Google Calendar *sync* of Epic 6. Nothing is connected,
 * no token is held and no account is read: the URL prefills a form, and the
 * customer presses Save. It cannot follow a later reschedule either — that is
 * what `CALENDAR_DISCONNECTED` and the real integration are for.
 */

export interface CalendarEventInput {
  /** The clinic. Ends up in the event title, since a calendar is full of them. */
  organizationName: string;
  serviceName: string;
  providerName: string;
  locationName: string | null;
  locationAddress: string | null;
  /** The short human reference, so the entry is traceable back to the booking. */
  reference: string;
  startAt: Date;
  endAt: Date;
}

interface CalendarCopy {
  /** Only label in the description; everything else is a bare value. */
  reference: string;
  /** What the link says in the email. */
  action: string;
}

const CALENDAR_COPY: Record<Locale, CalendarCopy> = {
  hu: {
    reference: "Azonosító",
    action: "Hozzáadás a Google Naptárhoz",
  },
  en: {
    reference: "Reference",
    action: "Add to Google Calendar",
  },
};

/** What the link should say. Kept beside the URL so the two cannot drift apart. */
export function calendarActionLabel(locale: Locale): string {
  return CALENDAR_COPY[locale].action;
}

/**
 * The prefill URL, or null when the booking cannot describe an event.
 *
 * Null rather than a best guess: a template that receives null drops the link,
 * which is a confirmation email missing one convenience. A URL built from an
 * invalid date is an entry saved into somebody's calendar at the wrong moment,
 * and they will trust it over the email.
 */
export function buildGoogleCalendarUrl(locale: Locale, event: CalendarEventInput): string | null {
  const start = event.startAt.getTime();
  const end = event.endAt.getTime();

  // `Invalid Date` yields NaN from getTime() rather than throwing, so this is
  // the only check that catches one. The ordering test catches the other way a
  // caller can be wrong — a zero-length or reversed span is not an appointment.
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;

  const copy = CALENDAR_COPY[locale];

  const place = [event.locationName, event.locationAddress]
    .filter((part): part is string => part !== null && part !== "")
    .join(", ");

  const description = [event.providerName, `${copy.reference}: ${event.reference}`].join("\n");

  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `${event.serviceName} — ${event.organizationName}`,
    dates: `${utcBasic(event.startAt)}/${utcBasic(event.endAt)}`,
    details: description,
  });

  // Omitted rather than sent empty: Google shows a location field on the event
  // form whether or not it has anything in it, and a blank one invites the
  // customer to think we lost their clinic's address.
  if (place !== "") params.set("location", place);

  // `URLSearchParams` percent-encodes every value, so nothing here can escape
  // the query string. The template escapes the result again for HTML, which is
  // what turns the separating `&` into `&amp;` in the href.
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * `20260817T090000Z` — the basic-format UTC stamp Google's template parameter
 * expects. The extended ISO form with its dashes and colons is silently ignored
 * by the form, which produces an event at today's date rather than an error.
 */
function utcBasic(instant: Date): string {
  return instant.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
}
