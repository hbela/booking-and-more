import { z } from "zod";
import { idSchema } from "@bam/contracts";

/**
 * Request and response shapes for the calendar integration routes.
 * PRD §19.4, docs/phase-6-google-calendar-part-1.md §3.
 *
 * Declared here rather than inline so the return-path rule below has one home:
 * it is applied twice on purpose, once at the edge and once again just before
 * the browser is redirected.
 */

/**
 * A path within our own app, and nothing else.
 *
 * This value is stored at connect time and used to build a `Location` header
 * after Google hands the browser back — which is to say, it is an open-redirect
 * vector wearing the costume of a convenience feature. Three things are refused:
 *
 *  - anything not starting with `/`, which would be an absolute URL;
 *  - a leading `//`, which is protocol-relative and means *another host*, and is
 *    the form that gets past a naive "must start with a slash" check;
 *  - a backslash anywhere, because browsers normalise `\` to `/` in URLs, so
 *    `/\evil.example` is another spelling of the second case.
 *
 * Whitespace is excluded too — a header value cannot carry a newline, and
 * refusing it here is cheaper than escaping it later.
 */
export const returnPathSchema = z
  .string()
  .max(512)
  .regex(
    /^\/(?![/\\])[^\s\\]*$/u,
    "must be a path within this application, beginning with a single '/'",
  );

export const connectBodySchema = z.object({
  /** Whose diary the connected calendars will fill. */
  providerId: idSchema,
  /**
   * Where to send the browser once Google is done. Recorded on the state row
   * rather than round-tripped through Google, because everything that comes
   * back from a callback is attacker-controllable.
   */
  returnPath: returnPathSchema.optional(),
});

export const connectResponseSchema = z.object({
  /**
   * Google's consent screen. The caller navigates the *top-level* window here —
   * Google refuses to render in an iframe, and a popup is blocked often enough
   * to be a support burden.
   */
  authorizationUrl: z.url(),
  /** When the handshake stops being completable. */
  expiresAt: z.iso.datetime({ offset: true }),
});

/**
 * What Google appends to the redirect URI.
 *
 * Every field is optional because every field is absent in some real case: a
 * denial sends `error` and no `code`, and a stray visit sends nothing at all.
 * Declaring them required would answer a malformed callback with a 422 envelope
 * rendered in the browser, which is the one place a JSON error is useless.
 */
export const callbackQuerySchema = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(256).optional(),
});

// ---------------------------------------------------------------------------
// Reading our own state, and choosing a calendar (step 6)
// ---------------------------------------------------------------------------

export const integrationStatusSchema = z.enum(["ACTIVE", "NEEDS_RECONNECT", "DISCONNECTED"]);

/** One calendar this account writes to. */
export const calendarMappingSchema = z.object({
  id: idSchema,
  externalCalendarId: z.string(),
  calendarName: z.string().nullable(),
  writeBookings: z.boolean(),
  /** Always false in part 1. Part 2 turns it on rather than changing a shape. */
  readBusy: z.boolean(),
  active: z.boolean(),
});

/**
 * §25.6's dashboard, as numbers.
 *
 * The spec asks for "Calendar sync failed / Retry scheduled" on the screen, and
 * those are two different states rather than one message: `failed` is parked and
 * needs a human, `pending` plus `syncing` is work the sweep will get to. A single
 * "there is a problem" count would collapse the two and turn a transient blip
 * into an alarm.
 */
export const syncCountsSchema = z.object({
  pending: z.number().int().nonnegative(),
  syncing: z.number().int().nonnegative(),
  synced: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const integrationStateSchema = z.object({
  id: idSchema,
  accountEmail: z.email(),
  providerId: idSchema.nullable(),
  /** Denormalised for the screen; a disconnected provider reads as null. */
  providerName: z.string().nullable(),
  status: integrationStatusSchema,
  /**
   * Why it stopped, in Google's words rather than ours. Short and safe to render
   * — the classifier's `reason` never carries a token.
   */
  lastError: z.string().nullable(),
  connectedAt: z.iso.datetime({ offset: true }),
  scopes: z.array(z.string()),
  calendars: z.array(calendarMappingSchema),
  sync: syncCountsSchema,
});

export const integrationsResponseSchema = z.object({
  /**
   * Whether this deployment has Google credentials at all.
   *
   * Reported rather than inferred from an empty list: "nobody has connected a
   * calendar" and "this platform cannot offer calendars" produce the same empty
   * array and need opposite words on the screen.
   */
  configured: z.boolean(),
  integrations: z.array(integrationStateSchema),
});

export const googleCalendarSchema = z.object({
  id: z.string(),
  summary: z.string(),
  primary: z.boolean(),
  accessRole: z.string(),
  timeZone: z.string().nullable(),
  /** Whether this is the one currently receiving bookings. */
  selected: z.boolean(),
});

export const calendarsResponseSchema = z.object({
  items: z.array(googleCalendarSchema),
});

export const selectCalendarBodySchema = z.object({
  /** Google's own id — often an email address, sometimes `primary`. */
  externalCalendarId: z.string().min(1).max(320),
  /** What the provider saw it called. Cosmetic; refreshed on every listing. */
  calendarName: z.string().max(320).optional(),
});

export const selectCalendarResponseSchema = z.object({
  mapping: calendarMappingSchema,
  /**
   * How many upcoming bookings were queued for this calendar. Capped by
   * `CALENDAR_BACKFILL_LIMIT`, soonest first.
   */
  backfilled: z.number().int().nonnegative(),
  /**
   * The calendar this provider was writing to before, if it changed.
   *
   * Present means events already created stay where they are — the record's
   * known limit 6. The screen says so; nothing automatic is offered, because
   * moving them would mean deleting real entries out of somebody's diary.
   */
  replacedCalendarId: z.string().nullable(),
});

export const syncResponseSchema = z.object({
  /** Parked rows put back in the queue. */
  requeued: z.number().int().nonnegative(),
});

export const disconnectResponseSchema = z.object({
  id: idSchema,
  status: z.literal("DISCONNECTED"),
  accountEmail: z.email(),
  /** How many selected calendars stopped receiving bookings. */
  deactivatedCalendars: z.number().int().nonnegative(),
  /**
   * Whether Google was told to forget the grant. False when the token could not
   * be opened or Google refused — the disconnection still happened, and the
   * screen says so rather than claiming a revocation that did not occur.
   */
  revokedAtGoogle: z.boolean(),
});
