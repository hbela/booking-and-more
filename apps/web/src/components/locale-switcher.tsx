"use client";

import { useLocale } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing, type Locale } from "@/i18n/routing";

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
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <select
        value={locale}
        onChange={(event) => {
          router.replace(pathname, { locale: event.target.value });
        }}
        className="rounded-md border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700"
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
