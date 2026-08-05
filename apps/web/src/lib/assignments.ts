import type { AssignedLocation, AssignedService, Location, Service } from "./api-client";

/**
 * Building the bodies for `PUT /v1/providers/:id/{services,locations}`.
 *
 * ## Why this is a separate, pure module
 *
 * Both endpoints replace the *whole set*: every assignment the body omits is
 * deleted. The editor is a checkbox list, so it is very natural to write
 * `ids.map((serviceId) => ({ serviceId }))` — and that is exactly what the first
 * version did. It cost every per-provider duration override, every per-provider
 * price, and every paused assignment, silently, on each save.
 *
 * The rule that prevents it is structural rather than remembered: **a whole-set
 * body may only be built from a fully-resolved read of that same set.** So
 * {@link buildProviderServicesBody} takes the loaded rows and nothing else —
 * there is no id-only overload to reach for — and the seeding functions are the
 * only way to obtain those rows. Being pure, both halves are unit-tested without
 * a DOM, which is where the original bug would have been caught.
 */

export interface ServiceAssignmentRow {
  /** Whether the provider offers this service at all. */
  checked: boolean;
  /** NULL means "use the service's own duration". */
  customDurationMinutes: number | null;
  /** Minor units in the *service's* currency — there is no currency of its own. */
  customPriceMinor: number | null;
  /**
   * The assignment's own flag: offered, but paused.
   *
   * Distinct from the service's `active`, and distinct again from
   * {@link checked}. The predecessor conflated this with membership — it seeded
   * the boxes from `assigned.filter((row) => row.active)` — so a paused
   * assignment rendered unticked and was deleted by the next save.
   */
  active: boolean;
}

export interface LocationAssignmentRow {
  checked: boolean;
  active: boolean;
}

export interface ProviderServiceInput {
  serviceId: string;
  customDurationMinutes: number | null;
  customPriceMinor: number | null;
  active: boolean;
}

/**
 * One row per live service, carrying whatever the existing assignment says.
 *
 * `services` decides which rows exist — the picker offers live services only —
 * and `assigned` decides what each row holds. A service the provider offers but
 * which has since been archived therefore has no row, and is deliberately absent
 * from the resulting body: the API leaves archived assignments alone precisely
 * so that this omission is not read as "unassign".
 */
export function seedServiceRows(args: {
  services: Service[];
  assigned: AssignedService[];
}): Map<string, ServiceAssignmentRow> {
  const byId = new Map(args.assigned.map((row) => [row.serviceId, row]));
  const rows = new Map<string, ServiceAssignmentRow>();

  for (const service of args.services) {
    const existing = byId.get(service.id);

    rows.set(service.id, {
      // Existence, not liveness — see ServiceAssignmentRow.active.
      checked: existing !== undefined,
      customDurationMinutes: existing?.customDurationMinutes ?? null,
      customPriceMinor: existing?.customPriceMinor ?? null,
      active: existing?.active ?? true,
    });
  }

  return rows;
}

export function seedLocationRows(args: {
  locations: Location[];
  assigned: AssignedLocation[];
}): Map<string, LocationAssignmentRow> {
  const byId = new Map(args.assigned.map((row) => [row.locationId, row]));
  const rows = new Map<string, LocationAssignmentRow>();

  for (const location of args.locations) {
    const existing = byId.get(location.id);
    rows.set(location.id, { checked: existing !== undefined, active: existing?.active ?? true });
  }

  return rows;
}

/**
 * The whole set, as the API expects it.
 *
 * Every field the GET returned travels back, which is the entire point: a field
 * missing here is a field deleted on the server.
 */
export function buildProviderServicesBody(rows: ReadonlyMap<string, ServiceAssignmentRow>): {
  services: ProviderServiceInput[];
} {
  const services: ProviderServiceInput[] = [];

  for (const [serviceId, row] of rows) {
    if (!row.checked) continue;

    services.push({
      serviceId,
      customDurationMinutes: row.customDurationMinutes,
      customPriceMinor: row.customPriceMinor,
      active: row.active,
    });
  }

  return { services };
}

export function buildProviderLocationsBody(rows: ReadonlyMap<string, LocationAssignmentRow>): {
  locations: { locationId: string; active: boolean }[];
} {
  const locations: { locationId: string; active: boolean }[] = [];

  for (const [locationId, row] of rows) {
    if (!row.checked) continue;
    locations.push({ locationId, active: row.active });
  }

  return { locations };
}

/**
 * What a number input holds, as the API wants it.
 *
 * An empty box means "inherit" and must travel as `null`, not as `0` — a
 * zero-minute duration and a free service are both real, different answers.
 */
export function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
