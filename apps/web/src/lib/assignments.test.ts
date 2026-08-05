import { describe, expect, it } from "vitest";
import type { AssignedLocation, AssignedService, Location, Service } from "./api-client";
import {
  buildProviderLocationsBody,
  buildProviderServicesBody,
  optionalNumber,
  seedLocationRows,
  seedServiceRows,
} from "./assignments";

/**
 * The regression suite for the assignment editor's data loss.
 *
 * Every case here describes a save that used to destroy something. None of it
 * needs a DOM, which is the point: the bug lived in the browser, the API was
 * always correct, and so the API suite could not have caught it.
 */

function service(id: string, over: Partial<Service> = {}): Service {
  return {
    id,
    name: id,
    slug: id,
    description: null,
    durationMinutes: 45,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceMinor: 1_500_000,
    currency: "HUF",
    active: true,
    requiresApproval: false,
    minimumNoticeMinutes: null,
    maximumAdvanceDays: null,
    translations: [],
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

function assigned(id: string, over: Partial<AssignedService> = {}): AssignedService {
  return {
    serviceId: id,
    serviceName: id,
    serviceSlug: id,
    serviceActive: true,
    durationMinutes: 45,
    customDurationMinutes: null,
    customPriceMinor: null,
    active: true,
    ...over,
  };
}

function location(id: string): Location {
  return {
    id,
    name: id,
    type: "PHYSICAL",
    addressLine1: "Váci út 1",
    addressLine2: null,
    city: "Budapest",
    postalCode: "1134",
    countryCode: "HU",
    timezone: "Europe/Budapest",
    latitude: null,
    longitude: null,
    active: true,
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("service assignments", () => {
  it("carries a per-provider duration and price through a save", () => {
    // The reported bug: the body was built from ids alone, so both overrides
    // were gone the moment anyone pressed Save on an unrelated checkbox.
    const rows = seedServiceRows({
      services: [service("cleaning")],
      assigned: [assigned("cleaning", { customDurationMinutes: 60, customPriceMinor: 2_000_000 })],
    });

    expect(buildProviderServicesBody(rows).services).toEqual([
      {
        serviceId: "cleaning",
        customDurationMinutes: 60,
        customPriceMinor: 2_000_000,
        active: true,
      },
    ]);
  });

  it("keeps a paused assignment ticked, and paused", () => {
    // The predecessor seeded from `assigned.filter((row) => row.active)`, so a
    // paused assignment rendered unticked and the next save deleted it.
    const rows = seedServiceRows({
      services: [service("cleaning")],
      assigned: [assigned("cleaning", { active: false })],
    });

    expect(rows.get("cleaning")).toMatchObject({ checked: true, active: false });
    expect(buildProviderServicesBody(rows).services).toEqual([
      expect.objectContaining({ serviceId: "cleaning", active: false }),
    ]);
  });

  it("omits an unassigned service, so unticking still removes it", () => {
    // The guard against data loss must not turn the whole-set PUT into an
    // append-only operation.
    const rows = seedServiceRows({
      services: [service("cleaning"), service("whitening")],
      assigned: [assigned("cleaning")],
    });

    expect(buildProviderServicesBody(rows).services).toEqual([
      expect.objectContaining({ serviceId: "cleaning" }),
    ]);
  });

  it("has no row for an archived service the provider still offers", () => {
    // The picker lists live services only, so an archived one cannot be ticked
    // — and sending its id would 404. Its absence from the body is safe because
    // the API excludes archived rows from the delete sweep.
    const rows = seedServiceRows({
      services: [service("cleaning")],
      assigned: [assigned("cleaning"), assigned("retired")],
    });

    expect(rows.has("retired")).toBe(false);
    expect(buildProviderServicesBody(rows).services).toHaveLength(1);
  });

  it("defaults a newly ticked service to inheriting everything", () => {
    const rows = seedServiceRows({ services: [service("whitening")], assigned: [] });
    rows.set("whitening", { ...rows.get("whitening")!, checked: true });

    expect(buildProviderServicesBody(rows).services).toEqual([
      {
        serviceId: "whitening",
        customDurationMinutes: null,
        customPriceMinor: null,
        active: true,
      },
    ]);
  });

  it("builds an empty set rather than throwing when nothing is ticked", () => {
    const rows = seedServiceRows({ services: [service("cleaning")], assigned: [] });
    expect(buildProviderServicesBody(rows)).toEqual({ services: [] });
  });
});

describe("location assignments", () => {
  it("round-trips membership and the paused flag", () => {
    const rows = seedLocationRows({
      locations: [location("surgery"), location("annexe")],
      assigned: [
        {
          locationId: "surgery",
          locationName: "surgery",
          locationType: "PHYSICAL",
          locationActive: true,
          active: false,
        } satisfies AssignedLocation,
      ],
    });

    expect(buildProviderLocationsBody(rows)).toEqual({
      locations: [{ locationId: "surgery", active: false }],
    });
  });
});

describe("optionalNumber", () => {
  it("reads a blank box as inherit, not as zero", () => {
    // Zero is a real answer for both fields it feeds — a free service and a
    // zero-minute notice — so "" must not collapse into it.
    expect(optionalNumber("")).toBeNull();
    expect(optionalNumber("   ")).toBeNull();
    expect(optionalNumber("0")).toBe(0);
  });

  it("reads a number, and treats nonsense as unset", () => {
    expect(optionalNumber("60")).toBe(60);
    expect(optionalNumber("not a number")).toBeNull();
  });
});
