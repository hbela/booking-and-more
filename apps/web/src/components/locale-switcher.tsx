"use client";

import { useLocale } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing, type Locale } from "@/i18n/routing";
import { LOCALE_PREFERENCE_COOKIE, LOCALE_PREFERENCE_MAX_AGE } from "@/lib/locale-preference";

const LABELS: Record<Locale, string> = {
  hu: "Magyar",
  en: "English",
};

/**
 * A plain <select>: keyboard-navigable and screen-reader friendly for free,
 * which a custom dropdown would have to re-earn (PRD §12.4, WCAG 2.1 AA).
 */
export function LocaleSwitcher({ label }: { label: string }): React.ReactElement {
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();

  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-ink-subtle">{label}</span>
      <select
        value={locale}
        onChange={(event) => {
          // Recorded before navigating, because the booking page reads it on the
          // very next request to decide whether it may still apply the tenant's
          // language over the top. See lib/locale-preference.ts.
          document.cookie = `${LOCALE_PREFERENCE_COOKIE}=${event.target.value}; path=/; max-age=${LOCALE_PREFERENCE_MAX_AGE}; samesite=lax`;
          router.replace(pathname, { locale: event.target.value });
        }}
        className="border-line-strong text-ink rounded-md border bg-transparent px-2 py-1"
      >
        {routing.locales.map((value) => (
          <option key={value} value={value}>
            {LABELS[value]}
          </option>
        ))}
      </select>
    </label>
  );
}
