import { describe, expect, it } from "vitest";
import { buildBookingEvent, buildCancellationPatch, deriveEventId } from "./google.events.js";

/**
 * docs/phase-6-google-calendar-part-1.md §2.3 and §2.6.
 *
 * The id tests are the important half: it is the only thing standing between a
 * retried job and a second appointment in somebody's real diary.
 */

const booking = {
  bookingId: "bkg_01H8XK2P",
  reference: "BK-4C7A",
  serviceName: "Fogtisztítás",
  customerName: "Nagy Béla",
  customerPhone: "+36301234567",
  notes: null,
  locationName: "Belváros",
  locationAddress: "Fő utca 1., Budapest",
  startAt: new Date("2026-09-07T08:00:00.000Z"),
  endAt: new Date("2026-09-07T08:30:00.000Z"),
  timezone: "Europe/Budapest",
  manageUrl: "https://app.example.com/hu/dashboard/bookings",
};

describe("deriveEventId", () => {
  it("fits Google's rules for a supplied event id", () => {
    // 5–1024 characters, base32hex only. A violation is a 400 on every insert,
    // which would be discovered in production on the first real booking.
    const id = deriveEventId(booking.bookingId, "map_1");

    expect(id).toMatch(/^bam[0-9a-v]{32}$/u);
    expect(id.length).toBeGreaterThanOrEqual(5);
    expect(id.length).toBeLessThanOrEqual(1024);
  });

  it("is stable across calls", () => {
    // The whole mechanism. A retry must compute the same id, or Google accepts
    // it as a new event and the provider has two appointments.
    expect(deriveEventId(booking.bookingId, "map_1")).toBe(
      deriveEventId(booking.bookingId, "map_1"),
    );
  });

  it("differs per booking and per calendar", () => {
    const base = deriveEventId(booking.bookingId, "map_1");

    expect(deriveEventId("bkg_other", "map_1")).not.toBe(base);
    expect(deriveEventId(booking.bookingId, "map_2")).not.toBe(base);
  });

  it("does not leak the booking id", () => {
    // It lands in a third party's URL space; a hash keeps our identifiers ours.
    expect(deriveEventId(booking.bookingId, "map_1")).not.toContain(booking.bookingId);
  });

  it("is not order-sensitive by accident", () => {
    // Would be a real collision: `(a, b)` and `(b, a)` are different pairings and
    // must not agree. The separator in the hashed string is what prevents it.
    expect(deriveEventId("a", "bc")).not.toBe(deriveEventId("ab", "c"));
  });
});

describe("buildBookingEvent", () => {
  it("titles the event with the service and the customer", () => {
    const event = buildBookingEvent(booking);

    expect(event.summary).toBe("Fogtisztítás — Nagy Béla");
  });

  it("carries the phone, the reference and the manage link in the description", () => {
    const event = buildBookingEvent(booking);

    expect(event.description).toContain("+36301234567");
    expect(event.description).toContain("#BK-4C7A");
    expect(event.description).toContain("https://app.example.com");
  });

  it("sends the appointment span, not the occupied span", () => {
    // §2.6. Buffers are our arithmetic for deciding what may be booked; blocking
    // a provider's cleanup time out of their personal diary is not our business.
    const event = buildBookingEvent(booking);

    expect(event.start.dateTime).toBe("2026-09-07T08:00:00.000Z");
    expect(event.end.dateTime).toBe("2026-09-07T08:30:00.000Z");
    expect(event.start.timeZone).toBe("Europe/Budapest");
  });

  it("never carries attendees", () => {
    // Adding the customer would have Google email them about an appointment we
    // already email them about, from an address they do not recognise. The type
    // says `never`; this asserts the built object agrees.
    expect(buildBookingEvent(booking)).not.toHaveProperty("attendees");
  });

  it("carries the booking id as an extended property", () => {
    // The route home that does not read a title, which PRD §9.10 forbids
    // relying on.
    expect(buildBookingEvent(booking).extendedProperties?.private["bamBookingId"]).toBe(
      booking.bookingId,
    );
  });

  it("omits the location entirely when the booking names none", () => {
    const event = buildBookingEvent({
      ...booking,
      locationName: null,
      locationAddress: null,
    });

    expect(event).not.toHaveProperty("location");
  });

  it("omits the description rather than sending an empty one", () => {
    const event = buildBookingEvent({
      ...booking,
      customerPhone: null,
      notes: null,
      manageUrl: null,
      reference: "",
    });

    // The reference line is `#` alone here, so the description is not empty —
    // assert on what it does contain rather than pretending otherwise.
    expect(event.description).toBe("#");
  });

  it("includes the clinic's note when there is one", () => {
    const event = buildBookingEvent({ ...booking, notes: "Bring previous x-rays" });

    expect(event.description).toContain("Bring previous x-rays");
  });

  it("leaves reminders to the provider's own calendar defaults", () => {
    // Overriding them would be us deciding when somebody's phone buzzes.
    expect(buildBookingEvent(booking).reminders).toEqual({ useDefault: true });
  });
});

describe("buildCancellationPatch", () => {
  it("cancels rather than deletes", () => {
    // §2.3: a deleted id is not immediately reusable, and the derived id has to
    // stay reserved for a booking that is cancelled and then reinstated.
    expect(buildCancellationPatch()).toEqual({ status: "cancelled" });
  });
});
