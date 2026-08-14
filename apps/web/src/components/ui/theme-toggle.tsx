"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  THEME_PREFERENCE_COOKIE,
  THEME_PREFERENCE_MAX_AGE,
  readThemePreference,
  type ThemePreference,
} from "@/lib/theme-preference";

/** "system" is the absence of a cookie, not a third stored value. */
type Choice = ThemePreference | "system";

/**
 * Light / dark / follow-the-system, as a plain `<select>`.
 *
 * Same control as {@link ../locale-switcher.tsx} and for the same reason: a
 * native select is keyboard-navigable and screen-reader friendly for free,
 * which a custom dropdown or a pair of icon buttons would each have to re-earn
 * (PRD §12.4, WCAG 2.1 AA). It is also honestly three-valued, which a single
 * toggle button is not — "follow my system" is a real choice and the default.
 *
 * ## Why the state starts empty
 *
 * The stored choice lives in a cookie the server deliberately does not read
 * (lib/theme-script.ts explains why). So the server cannot know which option is
 * selected, and rendering a guess would be a hydration mismatch on exactly the
 * screens where somebody has expressed a preference. Instead the first render
 * is always "system" and an effect corrects it after mount.
 *
 * The visible page is never wrong in the meantime — the inline script has
 * already applied the real theme before first paint. Only this control's own
 * selected option settles a tick late, and it is not on the critical path of
 * anything.
 */
export function ThemeToggle(): React.ReactElement {
  const t = useTranslations("common");
  const [choice, setChoice] = useState<Choice>("system");

  useEffect(() => {
    setChoice(readThemePreference(document.cookie) ?? "system");
  }, []);

  function apply(next: Choice): void {
    setChoice(next);

    if (next === "system") {
      // Expiring the cookie is what restores the third state. Writing
      // "system" into it would make the absence meaningless, and the CSS in
      // globals.css §2 keys on the attribute being absent, not on its value.
      document.cookie = `${THEME_PREFERENCE_COOKIE}=; path=/; max-age=0; samesite=lax`;
      delete document.documentElement.dataset.theme;
      return;
    }

    document.cookie = `${THEME_PREFERENCE_COOKIE}=${next}; path=/; max-age=${THEME_PREFERENCE_MAX_AGE}; samesite=lax`;
    document.documentElement.dataset.theme = next;
  }

  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-ink-subtle">{t("theme")}</span>
      <select
        value={choice}
        onChange={(event) => {
          apply(event.target.value as Choice);
        }}
        className="border-line-strong text-ink rounded-md border bg-transparent px-2 py-1"
      >
        <option value="system">{t("themeSystem")}</option>
        <option value="light">{t("themeLight")}</option>
        <option value="dark">{t("themeDark")}</option>
      </select>
    </label>
  );
}
