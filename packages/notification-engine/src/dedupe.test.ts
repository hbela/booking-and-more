import { describe, expect, it } from "vitest";

import { buildDedupeKey, utcDayOf } from "./dedupe.js";
import { NotificationChannels, NotificationTypes } from "./types.js";

const EMAIL = NotificationChannels.EMAIL;

describe("buildDedupeKey", () => {
  it("is stable for the same message", () => {
    const input = {
      type: NotificationTypes.BOOKING_CONFIRMATION,
      channel: EMAIL,
      bookingId: "bkg_1",
    } as const;

    expect(buildDedupeKey(input)).toBe(buildDedupeKey(input));
  });

  it("separates types so a cancellation does not dedupe against a confirmation", () => {
    const confirmation = buildDedupeKey({
      type: NotificationTypes.BOOKING_CONFIRMATION,
      channel: EMAIL,
      bookingId: "bkg_1",
    });
    const cancellation = buildDedupeKey({
      type: NotificationTypes.BOOKING_CANCELLED,
      channel: EMAIL,
      bookingId: "bkg_1",
    });

    expect(confirmation).not.toBe(cancellation);
  });

  it("separates channels: the same news by email and by SMS is two messages", () => {
    const byEmail = buildDedupeKey({
      type: NotificationTypes.BOOKING_CONFIRMATION,
      channel: NotificationChannels.EMAIL,
      bookingId: "bkg_1",
    });
    const bySms = buildDedupeKey({
      type: NotificationTypes.BOOKING_CONFIRMATION,
      channel: NotificationChannels.SMS,
      bookingId: "bkg_1",
    });

    expect(byEmail).not.toBe(bySms);
  });

  it("separates bookings", () => {
    const first = buildDedupeKey({
      type: NotificationTypes.BOOKING_CONFIRMATION,
      channel: EMAIL,
      bookingId: "bkg_1",
    });
    const second = buildDedupeKey({
      type: NotificationTypes.BOOKING_CONFIRMATION,
      channel: EMAIL,
      bookingId: "bkg_2",
    });

    expect(first).not.toBe(second);
  });

  describe("BOOKING_UPDATED", () => {
    // The bug a naive dedupe on (type, bookingId) introduces: a booking moved
    // twice owes two emails, and the second would be silently swallowed.
    it("gives a rescheduled-twice booking two distinct keys", () => {
      const afterFirstMove = buildDedupeKey({
        type: NotificationTypes.BOOKING_UPDATED,
        channel: EMAIL,
        bookingId: "bkg_1",
        bookingVersion: 1,
      });
      const afterSecondMove = buildDedupeKey({
        type: NotificationTypes.BOOKING_UPDATED,
        channel: EMAIL,
        bookingId: "bkg_1",
        bookingVersion: 2,
      });

      expect(afterFirstMove).not.toBe(afterSecondMove);
    });

    it("collapses a redelivered event for the same version", () => {
      const input = {
        type: NotificationTypes.BOOKING_UPDATED,
        channel: EMAIL,
        bookingId: "bkg_1",
        bookingVersion: 7,
      } as const;

      expect(buildDedupeKey(input)).toBe(buildDedupeKey(input));
    });
  });

  describe("BOOKING_REMINDER", () => {
    it("keys on the appointment start, so a reschedule earns a new reminder", () => {
      const original = buildDedupeKey({
        type: NotificationTypes.BOOKING_REMINDER,
        channel: EMAIL,
        bookingId: "bkg_1",
        startAtIso: "2026-08-01T09:00:00.000Z",
      });
      const moved = buildDedupeKey({
        type: NotificationTypes.BOOKING_REMINDER,
        channel: EMAIL,
        bookingId: "bkg_1",
        startAtIso: "2026-08-02T09:00:00.000Z",
      });

      expect(original).not.toBe(moved);
    });

    it("treats the same instant written differently as the same reminder", () => {
      // A dispatcher formatting with an offset and one formatting in UTC must
      // not produce two reminders for one appointment.
      const utc = buildDedupeKey({
        type: NotificationTypes.BOOKING_REMINDER,
        channel: EMAIL,
        bookingId: "bkg_1",
        startAtIso: "2026-08-01T09:00:00.000Z",
      });
      const offset = buildDedupeKey({
        type: NotificationTypes.BOOKING_REMINDER,
        channel: EMAIL,
        bookingId: "bkg_1",
        startAtIso: "2026-08-01T11:00:00.000+02:00",
      });

      expect(utc).toBe(offset);
    });

    it("contains no colon, despite being built from a timestamp", () => {
      const key = buildDedupeKey({
        type: NotificationTypes.BOOKING_REMINDER,
        channel: EMAIL,
        bookingId: "bkg_1",
        startAtIso: "2026-08-01T09:00:00.000Z",
      });

      // Four separators: scheme, type, channel, bookingId, epoch millis.
      expect(key.split(":")).toHaveLength(5);
    });

    it("refuses an unparseable start rather than keying on Invalid Date", () => {
      expect(() =>
        buildDedupeKey({
          type: NotificationTypes.BOOKING_REMINDER,
          channel: EMAIL,
          bookingId: "bkg_1",
          startAtIso: "not-a-date",
        }),
      ).toThrow(/parseable ISO-8601/u);
    });
  });

  it("refuses a part containing the separator", () => {
    expect(() =>
      buildDedupeKey({
        type: NotificationTypes.BOOKING_CONFIRMATION,
        channel: EMAIL,
        bookingId: "bkg:1",
      }),
    ).toThrow(/must not contain/u);
  });

  it("refuses an empty part", () => {
    expect(() =>
      buildDedupeKey({
        type: NotificationTypes.BOOKING_CONFIRMATION,
        channel: EMAIL,
        bookingId: "",
      }),
    ).toThrow(/must not be empty/u);
  });
});

describe("utcDayOf", () => {
  it("reduces an instant to its UTC day", () => {
    expect(utcDayOf("2026-08-01T23:30:00.000Z")).toBe("2026-08-01");
  });

  it("refuses an unparseable instant", () => {
    expect(() => utcDayOf("nope")).toThrow(/parseable ISO-8601/u);
  });
});
