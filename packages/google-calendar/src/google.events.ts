import { createHash } from "node:crypto";

/**
 * What a booking looks like as a Google Calendar event, and what its id is.
 * docs/phase-6-google-calendar-part-1.md §2.3, §2.6.
 *
 * Pure, and separate from the HTTP layer, because these two decisions are the
 * ones with consequences: the id is the whole idempotency mechanism, and the
 * body is what a provider reads on their phone and what leaves our servers
 * about a customer.
 */

/**
 * Google's own limits on a supplied event id: 5–1024 characters from the
 * base32hex alphabet, lowercase.
 */
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

/**
 * A prefix so an event of ours is recognisable in a calendar full of them —
 * by a developer reading a URL, never by code. PRD §9.10 forbids identifying a
 * booking by anything Google-side except the stored mapping.
 */
const ID_PREFIX = "bam";

/**
 * The event id for a booking in a calendar. **Deterministic, and that is the
 * point.**
 *
 * `events.insert` accepts no `Idempotency-Key`, but it does let the caller
 * supply the id and refuses a duplicate with `409`. So the id *is* the
 * idempotency key: a retry that lands after the first insert already committed
 * is refused by Google rather than putting a second appointment in somebody's
 * diary.
 *
 * That is the case a unique index on our side cannot cover — a worker killed
 * between Google's 200 and our row update has no row to conflict with. The id is
 * therefore derived rather than read back from Google.
 *
 * It is a hash, so no booking id of ours leaks into a third party's URL space,
 * and it is 35 characters — comfortably inside Google's range.
 */
export function deriveEventId(bookingId: string, calendarMappingId: string): string {
  const digest = createHash("sha256").update(`${bookingId}:${calendarMappingId}`).digest();

  // Base32hex over the first 20 bytes: 160 bits is far more than enough to make
  // a collision impossible in practice, and encodes to exactly 32 characters
  // with no padding to strip.
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of digest.subarray(0, 20)) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += ID_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  return `${ID_PREFIX}${out}`;
}

/** Everything the event body is built from. Already resolved by the caller. */
export interface BookingEventInput {
  bookingId: string;
  reference: string;
  serviceName: string;
  customerName: string;
  customerPhone: string | null;
  /** The clinic's own note on the booking, if any. */
  notes: string | null;
  locationName: string | null;
  locationAddress: string | null;
  /** The appointment itself, as instants. Buffers are excluded — see below. */
  startAt: Date;
  endAt: Date;
  /** IANA zone of the appointment, for the `dateTime`/`timeZone` pair. */
  timezone: string;
  /** Where a member of staff goes to act on it. */
  manageUrl: string | null;
}

/** The subset of Google's Event resource this package ever sends. */
export interface GoogleEventBody {
  id?: string;
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  status?: "confirmed" | "cancelled";
  /** Never a person. See the note on attendees below. */
  attendees?: never;
  extendedProperties?: { private: Record<string, string> };
  reminders?: { useDefault: boolean };
}

/**
 * A booking as an event.
 *
 * ## Three decisions live in this function
 *
 * **The span is the appointment, not the occupied span.** Buffers are our
 * arithmetic for deciding what may be booked; a calendar entry is for a human,
 * and blocking out a provider's cleanup time in their personal diary would be
 * an odd thing to do to them. Same distinction phase-3-4 §2.2 draws.
 *
 * **The customer's name travels.** A diary entry a provider cannot identify at a
 * glance is close to useless, which is most of the reason to sync at all. It is
 * a deliberate PRD §13.3 decision, recorded in §2.6 rather than left implicit,
 * and the obvious later concession is a tenant setting that reduces this to the
 * reference.
 *
 * **There are no attendees, ever** — the type says `never` so it cannot be added
 * without reading this. Adding the customer would make Google email them about
 * an appointment we already email them about, from an address they do not
 * recognise, in a language nobody chose. The customer's relationship is with the
 * clinic.
 */
export function buildBookingEvent(input: BookingEventInput): GoogleEventBody {
  const place = [input.locationName, input.locationAddress]
    .filter((part): part is string => part !== null && part !== "")
    .join(", ");

  const description = [
    input.customerPhone === null || input.customerPhone === "" ? null : input.customerPhone,
    `#${input.reference}`,
    input.notes === null || input.notes === "" ? null : input.notes,
    input.manageUrl,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return {
    summary: `${input.serviceName} — ${input.customerName}`,
    ...(description === "" ? {} : { description }),
    // Omitted rather than sent empty: Google renders the field regardless, and a
    // blank one reads as an address we lost.
    ...(place === "" ? {} : { location: place }),
    start: { dateTime: input.startAt.toISOString(), timeZone: input.timezone },
    end: { dateTime: input.endAt.toISOString(), timeZone: input.timezone },
    // The route home that does not read a title (PRD §9.10). The mapping row is
    // the authority; this is a second way to find it during part 2, and a way a
    // human can tell whose event this is when looking at raw JSON.
    extendedProperties: { private: { bamBookingId: input.bookingId } },
    // The provider's own calendar defaults. Overriding them would be us
    // deciding when somebody gets a popup on their phone.
    reminders: { useDefault: true },
  };
}

/**
 * The patch that cancels an event without deleting it.
 *
 * `status: "cancelled"` rather than `DELETE`, because a deleted id is not
 * immediately reusable and the derived id has to stay reserved — a booking that
 * is cancelled and then reinstated must land on the same event. PRD §9.10
 * permits "delete **or** cancel"; this is the half that keeps §2.3's guarantee.
 *
 * The provider still sees it, greyed out, which is also the more useful answer:
 * an appointment vanishing without trace is indistinguishable from a sync bug.
 */
export function buildCancellationPatch(): { status: "cancelled" } {
  return { status: "cancelled" };
}
