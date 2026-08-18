import { describe, expect, it } from "vitest";
import {
  fingerprintWorkingHours,
  type FingerprintableWorkingHours,
} from "./working-hours-fingerprint.js";

function period(
  overrides: Partial<FingerprintableWorkingHours> = {},
): FingerprintableWorkingHours {
  return {
    locationId: null,
    weekday: 1,
    startTime: "09:00",
    endTime: "17:00",
    validFrom: null,
    validUntil: null,
    active: true,
    ...overrides,
  };
}

describe("fingerprintWorkingHours", () => {
  it("is stable for the same week", () => {
    expect(fingerprintWorkingHours([period()])).toBe(fingerprintWorkingHours([period()]));
  });

  it("gives the empty week a constant of its own", () => {
    // A fresh provider is legitimately in this state, so it has to fingerprint
    // to something rather than being a special case at the call site.
    expect(fingerprintWorkingHours([])).toBe(fingerprintWorkingHours([]));
    expect(fingerprintWorkingHours([])).not.toBe(fingerprintWorkingHours([period()]));
  });

  it("does not depend on the order rows came back in", () => {
    // The repository orders by (weekday, startTime), which is not a total order:
    // two periods can share both and differ only by location. Without the sort,
    // one week could fingerprint two ways and refuse a caller who did nothing.
    const a = period({ locationId: "loc-a" });
    const b = period({ locationId: "loc-b" });

    expect(fingerprintWorkingHours([a, b])).toBe(fingerprintWorkingHours([b, a]));
  });

  it("changes when any field of any period changes", () => {
    const base = fingerprintWorkingHours([period()]);

    expect(fingerprintWorkingHours([period({ weekday: 2 })])).not.toBe(base);
    expect(fingerprintWorkingHours([period({ startTime: "09:30" })])).not.toBe(base);
    expect(fingerprintWorkingHours([period({ endTime: "16:00" })])).not.toBe(base);
    expect(fingerprintWorkingHours([period({ locationId: "loc-a" })])).not.toBe(base);
    expect(fingerprintWorkingHours([period({ active: false })])).not.toBe(base);
    expect(
      fingerprintWorkingHours([period({ validFrom: new Date("2026-03-01T00:00:00.000Z") })]),
    ).not.toBe(base);
    expect(
      fingerprintWorkingHours([period({ validUntil: new Date("2026-03-01T00:00:00.000Z") })]),
    ).not.toBe(base);
  });

  it("changes when a period is added or removed", () => {
    const one = fingerprintWorkingHours([period()]);
    const two = fingerprintWorkingHours([period(), period({ weekday: 3 })]);

    expect(one).not.toBe(two);
  });

  it("ignores row identity, so re-saving an identical week is not a conflict", () => {
    // The load-bearing decision. Every save deletes and re-inserts, minting new
    // ids; if identity were in the digest, somebody saving the very hours you
    // are looking at would trigger a conflict dialog about nothing.
    const before = fingerprintWorkingHours([period(), period({ weekday: 3 })]);
    const afterAnIdenticalSave = fingerprintWorkingHours([period({ weekday: 3 }), period()]);

    expect(afterAnIdenticalSave).toBe(before);
  });

  it("does not collide across weeks that differ only in how fields split", () => {
    // The separator earns its place: without it "09:00" + "17:00" and "09:0" +
    // "017:00" would serialise the same.
    const a = fingerprintWorkingHours([period({ startTime: "09:00", endTime: "17:00" })]);
    const b = fingerprintWorkingHours([period({ startTime: "09:0", endTime: "017:00" })]);

    expect(a).not.toBe(b);
  });
});
