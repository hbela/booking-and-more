"use client";

import type { ErrorEnvelope, UncoveredReasonCode } from "@bam/contracts";

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
    /**
     * The envelope's `details`, untyped on purpose.
     *
     * Its shape varies by code — a field name for a validation failure, a list
     * of affected bookings for `SCHEDULE_CONFLICTS_BOOKINGS` — so it is carried
     * as `unknown` and narrowed by whoever knows which code they asked about.
     * Typing it here would mean a union of every error's details in one place.
     */
    public readonly details?: unknown,
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
      envelope?.error?.details,
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
    /** PENDING_SUBSCRIPTION is where a newly provisioned owner lands; the API
     *  refuses their writes until it changes (phase-9 §2.4). */
    status: "PENDING_SUBSCRIPTION" | "TRIAL" | "ACTIVE" | "SUSPENDED" | "CLOSED";
    defaultTimezone: string;
    defaultLanguage: string;
    subscribeBy: string | null;
    /** Null means *no deadline*, not none left — an internal organization.
     *  Render no countdown at all in that case (phase-9 §2.2). */
    daysRemaining: number | null;
  } | null;
  membership: { id: string; role: string; providerId: string | null } | null;
  permissions: string[];
  /** Commercial feature flags from the selected tenant's live subscription. */
  features: { assistant: boolean };
  /**
   * Diaries handed to this membership, and what each grant covers
   * (docs/phase-3-4-diary-delegation.md). Ids only — `GET /v1/me/delegations`
   * is the version with provider names, fetched by the screens that need to
   * label a picker.
   *
   * Advisory, like `permissions`: the API re-decides every request.
   */
  delegations: { providerId: string; scopes: DelegationScope[] }[];
}

export type DelegationScope = "AVAILABILITY" | "BOOKINGS";

/** One row of `GET /v1/me/delegations`. */
export interface MyDelegation {
  providerId: string;
  providerName: string;
  providerTimezone: string;
  providerArchived: boolean;
  scopes: DelegationScope[];
}

/** One row of `GET /v1/providers/:id/delegations`. */
export interface ProviderDelegation {
  providerId: string;
  scopes: DelegationScope[];
  grantedAt: string;
  grantedByUserId: string | null;
  member: DelegationMember;
}

export interface DelegationMember {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  /** False once the member's role no longer receives delegations: the grant
   *  survives a role change and confers nothing (delegation record §2.8). */
  roleReceivesDelegations: boolean;
}

export type DelegationCandidate = DelegationMember & { alreadyDelegated: boolean };

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
  /**
   * The diary this membership holds. Null on every non-provider member, and on
   * a PROVIDER it is the difference between a working login and one whose every
   * permission matches nothing — which is why the members table shows it.
   */
  providerId: string | null;
  joinedAt: string | null;
  user: { id: string; name: string; email: string };
}

export interface Invitation {
  id: string;
  email: string;
  role: string;
  /** The diary a PROVIDER invitation is for. Null for every other role. */
  providerId: string | null;
  expiresAt: string;
  invitedBy: { name: string; email: string };
}

/** What `POST /v1/providers/:id/invitation` returns. Shown once — see §2.6. */
export interface ProviderInvitation {
  id: string;
  email: string;
  role: "PROVIDER";
  providerId: string;
  expiresAt: string;
  acceptUrl: string;
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
  /** Owner override: services that normally need approval confirm immediately. */
  autoConfirmBookings: boolean;
  /** NULL means *inherit*, not zero — the engine takes the most restrictive
   *  value that applies (tech-impl §13.3, `provider.schemas.ts` §4-13). Zero is
   *  a real value meaning "bookable up to the last second". */
  minimumNoticeMinutes: number | null;
  maximumAdvanceDays: number | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
  /** NULL means *inherit* — see {@link Provider.minimumNoticeMinutes}. */
  minimumNoticeMinutes: number | null;
  maximumAdvanceDays: number | null;
  translations: ServiceTranslation[];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET /v1/services/:serviceId`, which carries the assignments the list does not.
 *
 * Read-only here: assignments are written from the provider side only, because a
 * second whole-set writer over `provider_services` would clobber the first with
 * no version column to notice.
 */
export interface ServiceDetail extends Service {
  providers: { providerId: string; displayName: string; active: boolean }[];
}

export type LocationType = "PHYSICAL" | "ONLINE" | "HOME_VISIT" | "TELEPHONE";

export interface Location {
  id: string;
  name: string;
  type: LocationType;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postalCode: string | null;
  countryCode: string | null;
  timezone: string;
  /** Stored but unread until the public map (phase-2 §5.5). */
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One row of `GET /v1/providers/:id/services`.
 *
 * Every field here has to survive a round trip through the assignment editor:
 * the matching `PUT` replaces the whole set, so anything the editor fails to
 * send back is deleted. See `buildProviderServicesBody` in `./assignments`.
 */
export interface AssignedService {
  serviceId: string;
  serviceName: string;
  serviceSlug: string;
  /** The *service's* liveness: `active && archivedAt === null`. */
  serviceActive: boolean;
  /** Effective duration: `customDurationMinutes ?? service.durationMinutes`. */
  durationMinutes: number;
  /** NULL means "use the service's own". */
  customDurationMinutes: number | null;
  /** Minor units in the *service's* currency — there is no currency column here. */
  customPriceMinor: number | null;
  /** The assignment's own flag, distinct from {@link serviceActive}. */
  active: boolean;
}

export interface AssignedLocation {
  locationId: string;
  locationName: string;
  locationType: LocationType;
  locationActive: boolean;
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
 * Minor units back to what belongs in a price input.
 *
 * Needed by every edit form, and deliberately a function rather than a `/ 100`
 * at the call site: 1500000 is 15 000 Ft but 15 000.00 €, and getting that
 * wrong misprices a service by two orders of magnitude in exactly one currency —
 * the pilot tenant's.
 */
export function fromMinorUnits(minor: number, currency: string): number {
  return minor / 10 ** minorUnitDigits(currency);
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

/**
 * Who last saved a provider's week, from `GET .../working-hours`.
 *
 * Null when nothing has been saved since auditing began. Read-only provenance:
 * it does not stop two people clobbering each other — nothing does yet — it only
 * makes the other editor visible (docs/phase-3-4-diary-delegation.md §2.14).
 */
export interface ScheduleLastChange {
  at: string;
  /** Null when the audit row names no user, or that account is gone. */
  by: { userId: string; name: string } | null;
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

// --- Bookings (Epic 4) -----------------------------------------------------

export type BookingStatus =
  "PENDING" | "CONFIRMED" | "CANCELLED" | "COMPLETED" | "NO_SHOW" | "EXPIRED";

/** The staff shape. The public one is deliberately smaller — see {@link PublicBooking}. */
export interface Booking {
  id: string;
  reference: string;
  status: BookingStatus;
  source: string;
  providerId: string;
  providerName: string;
  serviceId: string;
  locationId: string | null;
  locationName: string | null;
  customerId: string;
  startAt: string;
  endAt: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  serviceName: string;
  priceMinor: number | null;
  currency: string | null;
  notes: string | null;
  cancellationReason: string | null;
  cancelledAt: string | null;
  /** Sent back on writes so two screens editing one booking cannot silently
   *  overwrite each other. */
  version: number;
  createdAt: string;
  /**
   * Why this appointment sits outside its provider's current schedule, or null.
   *
   * Only ever populated on the list — a single-booking response never asks
   * (docs/phase-3-4-schedule-conflicts.md §2.6) — so it is optional here rather
   * than nullable, and every reader must treat absent as "not asked".
   */
  outsideSchedule?: UncoveredReasonCode | null;
}

export interface Hold {
  id: string;
  providerId: string;
  serviceId: string;
  locationId: string | null;
  startAt: string;
  endAt: string;
  expiresAt: string;
  /** What the countdown starts from. Recomputed by the server on every read. */
  remainingSeconds: number;
}

/**
 * What a customer sees. Mirrors the API's separate public schema, and is a
 * different type on purpose (CLAUDE.md rule 12) — no version, no source, no
 * internal notes, no ids.
 */
export interface PublicBooking {
  tenantSlug: string;
  reference: string;
  status: "PENDING" | "CONFIRMED" | "CANCELLED" | "COMPLETED" | "NO_SHOW";
  startAt: string;
  endAt: string;
  providerName: string;
  serviceName: string;
  locationName: string | null;
  priceMinor: number | null;
  currency: string | null;
  customerName: string;
  cancellationPolicy: string | null;
}

export interface PublicBookingCreated extends PublicBooking {
  /** Returned once and never again — only its hash is stored (tech-impl §34.4). */
  managementToken: string;
}

export interface ChangePreview {
  reference: string;
  allowed: boolean;
  /** Already a sentence for the customer, not a reason code. */
  message: string | null;
}

export interface ReschedulePreview extends ChangePreview {
  current: { startAt: string; endAt: string };
  proposed: { startAt: string; endAt: string };
  providerName: string;
  serviceName: string;
}

export interface CancellationPreview extends ChangePreview {
  startAt: string;
  endAt: string;
  providerName: string;
  serviceName: string;
  cancellationPolicy: string | null;
}

/**
 * A fresh `Idempotency-Key` for one user action.
 *
 * Generated per *action*, never per page: a key that outlives the button press
 * is how a customer who books, goes back, and books a different slot gets the
 * first booking's response for the second request (tech-impl §32).
 *
 * `crypto.randomUUID` needs a secure context, which localhost and HTTPS both
 * are; the fallback keeps a plain-HTTP staging box working rather than throwing
 * inside a click handler.
 */
export function idempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Convenience for the write endpoints, all of which require the header. */
export function withIdempotency(key: string): Record<string, string> {
  return { "Idempotency-Key": key };
}
