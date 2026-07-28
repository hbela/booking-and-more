import { z } from "zod";

/**
 * Primitives shared across every module's schemas.
 * Keeping them here means the OpenAPI document describes one `Timezone`, not
 * fourteen subtly different string fields.
 */

/** Model IDs are CUID2-ish opaque strings; never parse meaning out of them. */
export const idSchema = z.string().min(1).max(64);

/** IANA zone name, e.g. `Europe/Budapest`. Validated against the runtime's own
 *  zone database rather than a hand-maintained list. */
export const timezoneSchema = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: "must be a valid IANA timezone, e.g. Europe/Budapest" },
);

/** BCP-47 language subtag. Hungarian and English at launch (PRD §12.5). */
export const languageSchema = z.enum(["hu", "en", "de", "fr"]);
export type Language = z.infer<typeof languageSchema>;

/** Calendar date, `YYYY-MM-DD`, no zone attached. */
export const dateOnlySchema = z.iso.date();

/** Wall-clock time, `HH:mm`. Used for recurring working hours, which are stored
 *  as local time and interpreted in the provider's zone (tech-impl §13.4). */
export const timeOnlySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:mm in 24-hour form");

/** Absolute instant, ISO 8601 with offset. All persisted timestamps are UTC. */
export const instantSchema = z.iso.datetime({ offset: true });

/** Monday = 1 … Sunday = 7 (ISO 8601). */
export const weekdaySchema = z.number().int().min(1).max(7);

/** Money is always integer minor units plus a currency (tech-impl §10.5). */
export const minorAmountSchema = z.number().int();
export const currencySchema = z.string().length(3).toUpperCase();

/** Cursor pagination envelope (tech-impl §15.2). */
export const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
