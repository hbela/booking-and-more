"use client";

import type { ErrorEnvelope } from "@bam/contracts";

const API_BASE_URL = process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "http://localhost:3001";

/**
 * Typed error carrying the API's machine-readable code and request ID.
 *
 * The request ID is the useful part: a user can quote it in a bug report and it
 * ties their failure to exactly one line in the server logs.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  /**
   * Sent as X-Tenant-Id. The API validates it against membership regardless.
   *
   * Explicitly `| undefined` so callers can pass a value that is still being
   * resolved without a cast (exactOptionalPropertyTypes is on).
   */
  tenantId?: string | undefined;
}

/**
 * Thin wrapper over fetch that understands the API's error envelope.
 *
 * Deliberately small — the pattern is lifted from booking-for-all's
 * `apiFetch.ts`, which was one of the genuinely good pieces of that codebase.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, tenantId, headers, ...rest } = options;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    // Cross-origin: without this the session cookie never travels.
    credentials: "include",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(tenantId === undefined ? {} : { "X-Tenant-Id": tenantId }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const envelope = payload as ErrorEnvelope | null;
    throw new ApiError(
      envelope?.error?.message ?? "Request failed.",
      envelope?.error?.code ?? "UNKNOWN",
      response.status,
      envelope?.error?.requestId,
    );
  }

  return payload as T;
}

// --- Shapes the dashboard needs -------------------------------------------
// Still hand-written. Generating these from the OpenAPI document is the right
// answer and remains on the list; it did not make Epic 2, so every type here is
// a promise the server has to keep on its own. The integration suite is what
// actually checks it.

/** Cursor pagination envelope (tech-impl §15.2). */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

export interface MeResponse {
  user: { id: string; name: string; email: string; isPlatformAdmin: boolean };
  tenant: {
    id: string;
    slug: string;
    name: string;
    status: "TRIAL" | "ACTIVE" | "SUSPENDED" | "CLOSED";
    defaultTimezone: string;
    defaultLanguage: string;
  } | null;
  membership: { id: string; role: string; providerId: string | null } | null;
  permissions: string[];
}

export interface TenantSummary {
  id: string;
  slug: string;
  name: string;
  status: string;
  role: string;
}

export interface Member {
  id: string;
  role: string;
  status: string;
  joinedAt: string | null;
  user: { id: string; name: string; email: string };
}

export interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  invitedBy: { name: string; email: string };
}

// --- Catalogue (Epic 2) ----------------------------------------------------

export interface Provider {
  id: string;
  displayName: string;
  description: string | null;
  email: string | null;
  phone: string | null;
  timezone: string;
  languages: string[];
  active: boolean;
  onlineBookingEnabled: boolean;
  archivedAt: string | null;
}

export interface ServiceTranslation {
  locale: string;
  name: string;
  description: string | null;
}

export interface Service {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  /** Integer minor units, with the currency alongside (tech-impl §10.5). */
  priceMinor: number | null;
  currency: string | null;
  active: boolean;
  requiresApproval: boolean;
  translations: ServiceTranslation[];
  archivedAt: string | null;
}

export type LocationType = "PHYSICAL" | "ONLINE" | "HOME_VISIT" | "TELEPHONE";

export interface Location {
  id: string;
  name: string;
  type: LocationType;
  addressLine1: string | null;
  city: string | null;
  postalCode: string | null;
  countryCode: string | null;
  timezone: string;
  active: boolean;
  archivedAt: string | null;
}

export interface AssignedService {
  serviceId: string;
  serviceName: string;
  serviceActive: boolean;
  durationMinutes: number;
  active: boolean;
}

export interface AssignedLocation {
  locationId: string;
  locationName: string;
  locationType: LocationType;
  active: boolean;
}

/**
 * Money for display.
 *
 * Minor units become a decimal exactly once, here, using the browser's own
 * currency rules — `Intl` knows that HUF has no minor unit and JPY has none
 * either, which a hard-coded `/ 100` does not.
 */
export function formatMoney(minor: number, currency: string, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency });
  return formatter.format(minor / 10 ** minorUnitDigits(currency));
}

/** The inverse: what the user typed into a price field, as minor units. */
export function toMinorUnits(amount: number, currency: string): number {
  return Math.round(amount * 10 ** minorUnitDigits(currency));
}

/**
 * How many decimal places this currency has.
 *
 * Asked of `Intl` rather than assumed to be two: HUF and JPY have none, so a
 * hard-coded `* 100` would price a 15 000 Ft cleaning at 1.5 million.
 */
function minorUnitDigits(currency: string): number {
  // `maximumFractionDigits` is optional in the type even though a currency
  // formatter always resolves one; two is the right guess if it ever does not.
  return (
    new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

// --- Availability (Epic 3) -------------------------------------------------

export interface WorkingHoursRow {
  id: string;
  providerId: string;
  locationId: string | null;
  /** ISO 8601: Monday = 1 … Sunday = 7. */
  weekday: number;
  /** Local `HH:mm` in the provider's zone, not an instant (tech-impl §13.4). */
  startTime: string;
  endTime: string;
  validFrom: string | null;
  validUntil: string | null;
  active: boolean;
}

export interface AvailabilityException {
  id: string;
  providerId: string;
  locationId: string | null;
  serviceId: string | null;
  type: "UNAVAILABLE" | "ADDITIONAL_AVAILABILITY";
  startAt: string;
  endAt: string;
  reason: string | null;
  source: string;
  createdAt: string;
}

export interface Slot {
  providerId: string;
  startAt: string;
  endAt: string;
  /** Includes buffers — the diary block, not the appointment. */
  occupiedFrom: string;
  occupiedUntil: string;
}
