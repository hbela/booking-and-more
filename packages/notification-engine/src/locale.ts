import { FALLBACK_LOCALE, SUPPORTED_LOCALES, type Locale } from "./types.js";

/**
 * Which language a message goes out in.
 *
 * The order is not arbitrary: what the customer chose beats what the tenant
 * defaults to, because the person reading the email is the customer. A clinic
 * whose default is Hungarian still owes an English confirmation to the patient
 * who booked in English.
 */

/**
 * Reduce a BCP-47 tag to a supported subtag.
 *
 * `hu-HU`, `HU` and `hu` are all Hungarian. Anything else — `de`, `""`, a
 * mangled value from an import — is not a supported language, and saying so is
 * better than silently sending German-labelled Hungarian.
 */
export function normalizeLocale(value: string | null | undefined): Locale | undefined {
  if (value === null || value === undefined) return undefined;

  // Region and script subtags are dropped: templates are per-language, and
  // splitting hu-HU from hu-SK would double the translation work to produce
  // identical files.
  const primary = value.trim().toLowerCase().split(/[-_]/u)[0];
  if (primary === undefined || primary === "") return undefined;

  return SUPPORTED_LOCALES.find((locale) => locale === primary);
}

export interface LocaleCandidates {
  /** `Customer.preferredLanguage`. */
  customerLanguage?: string | null | undefined;
  /** `Tenant.defaultLanguage`. */
  tenantLanguage?: string | null | undefined;
}

/**
 * First usable candidate wins; {@link FALLBACK_LOCALE} if none is.
 *
 * Never returns undefined. A message with no language is not a thing that can
 * be sent, so the decision has to terminate somewhere, and it terminates here
 * rather than in the template renderer where the failure would be a missing
 * key three layers down.
 */
export function resolveLocale(candidates: LocaleCandidates): Locale {
  return (
    normalizeLocale(candidates.customerLanguage) ??
    normalizeLocale(candidates.tenantLanguage) ??
    FALLBACK_LOCALE
  );
}
