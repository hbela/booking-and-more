import { describe, expect, it } from "vitest";
import { buildGoogleCalendarUrl, calendarActionLabel } from "./calendar.js";

const event = {
  organizationName: "Napfény Fogászat",
  serviceName: "Fogtisztítás",
  providerName: "Dr. Kiss Anna",
  locationName: "Belváros",
  locationAddress: "Fő utca 1., Budapest",
  reference: "BK-4C7A",
  startAt: new Date("2026-08-12T08:00:00.000Z"),
  endAt: new Date("2026-08-12T08:45:00.000Z"),
};

/** The query, parsed — asserting on a raw URL string asserts on encoding twice. */
function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("buildGoogleCalendarUrl", () => {
  it("points at the template form with both ends of the appointment", () => {
    const url = buildGoogleCalendarUrl("hu", event);

    expect(url).not.toBeNull();
    expect(url).toContain("https://calendar.google.com/calendar/render?");

    const params = paramsOf(url as string);
    expect(params.get("action")).toBe("TEMPLATE");
    expect(params.get("dates")).toBe("20260812T080000Z/20260812T084500Z");
  });

  it("stamps the instants in UTC, not in the clinic's zone", () => {
    // The email prints "10:00" for this booking because the clinic is in
    // Budapest. The event is 08:00Z, and Google renders it in whatever zone the
    // customer's calendar is set to — which is the whole point of the link.
    const params = paramsOf(buildGoogleCalendarUrl("en", event) as string);

    expect(params.get("dates")).toContain("T080000Z");
    expect(params.get("dates")).not.toContain("T100000");
  });

  it("names the service and the clinic in the title, and the rest in the body", () => {
    const params = paramsOf(buildGoogleCalendarUrl("en", event) as string);

    expect(params.get("text")).toBe("Fogtisztítás — Napfény Fogászat");
    expect(params.get("details")).toContain("Dr. Kiss Anna");
    expect(params.get("details")).toContain("Reference: BK-4C7A");
    expect(params.get("location")).toBe("Belváros, Fő utca 1., Budapest");
  });

  it("localizes the one label it prints", () => {
    const hu = paramsOf(buildGoogleCalendarUrl("hu", event) as string);

    expect(hu.get("details")).toContain("Azonosító: BK-4C7A");
    expect(calendarActionLabel("hu")).not.toBe(calendarActionLabel("en"));
  });

  it("omits the location entirely for a clinic that records none", () => {
    // Rather than sending an empty one: Google shows the field regardless, and a
    // blank value reads as an address we lost.
    const params = paramsOf(
      buildGoogleCalendarUrl("en", {
        ...event,
        locationName: null,
        locationAddress: null,
      }) as string,
    );

    expect(params.has("location")).toBe(false);
  });

  it("escapes values that would otherwise end the query string", () => {
    const params = paramsOf(
      buildGoogleCalendarUrl("en", {
        ...event,
        organizationName: "Smith & Sons",
        serviceName: "Check-up #1",
      }) as string,
    );

    // Round-tripped intact, which means the `&` never separated a parameter.
    expect(params.get("text")).toBe("Check-up #1 — Smith & Sons");
    expect(params.get("action")).toBe("TEMPLATE");
  });

  it("returns null rather than an event at the wrong moment", () => {
    // A saved calendar entry outlives the email and will be trusted over it, so
    // a span that cannot be described is dropped instead of guessed at.
    expect(buildGoogleCalendarUrl("en", { ...event, endAt: new Date("nonsense") })).toBeNull();
    expect(buildGoogleCalendarUrl("en", { ...event, endAt: event.startAt })).toBeNull();
    expect(
      buildGoogleCalendarUrl("en", { ...event, endAt: new Date("2026-08-12T07:00:00.000Z") }),
    ).toBeNull();
  });
});
