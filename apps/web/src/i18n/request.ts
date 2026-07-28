import { getRequestConfig } from "next-intl/server";
import { hasLocale } from "next-intl";
import { routing } from "./routing";

/** Shape of a messages file. Keeps the dynamic import from degrading to `any`. */
type Messages = Record<string, Record<string, unknown>>;

/**
 * Per-request locale resolution. Falls back to the default locale rather than
 * throwing, so an unknown prefix renders Hungarian instead of a 500.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  const imported = (await import(`../messages/${locale}.json`)) as { default: Messages };

  return {
    locale,
    messages: imported.default,
    timeZone: "Europe/Budapest",
  };
});
