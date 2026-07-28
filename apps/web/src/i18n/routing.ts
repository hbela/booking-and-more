import { defineRouting } from "next-intl/routing";

/**
 * Locale routing. PRD §12.5 — Hungarian and English at launch, German and
 * French planned.
 *
 * Hungarian is the default because the pilot tenant (Sunshine Dental) is
 * Hungarian. `localePrefix: "as-needed"` keeps the default locale's URLs clean
 * (`/book` rather than `/hu/book`) while still giving every other locale an
 * explicit, shareable prefix.
 */
export const routing = defineRouting({
  locales: ["hu", "en"],
  defaultLocale: "hu",
  localePrefix: "as-needed",
});

export type Locale = (typeof routing.locales)[number];
