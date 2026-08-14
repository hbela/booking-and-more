/**
 * Has this visitor chosen light or dark, or are we still following their
 * operating system?
 *
 * Deliberately the same shape as {@link ./locale-preference.ts}, and for the
 * same reason: absence has to be meaningful. `prefers-color-scheme` always
 * answers something, so it can never tell us whether the visitor *asked*. This
 * cookie is written in exactly one place — the theme toggle — so its presence
 * means intent, and its absence means "follow the system".
 *
 * That three-state distinction is the whole design. `globals.css` §2 resolves
 * it in CSS; nothing here has an opinion about which theme is nicer.
 */
export const THEME_PREFERENCE_COOKIE = "bam.theme";

/** A year, matching the locale cookie. A theme is not worth asking twice. */
export const THEME_PREFERENCE_MAX_AGE = 60 * 60 * 24 * 365;

/** The two values a visitor can choose. "System" is the *absence* of a cookie. */
export type ThemePreference = "light" | "dark";

/**
 * Read a preference out of an untrusted string.
 *
 * Returns `null` for anything else — a missing cookie, an empty value, or a
 * hand-edited one. `null` is not a failure here, it is the third state: follow
 * the system.
 */
export function parseThemePreference(raw: string | undefined | null): ThemePreference | null {
  return raw === "light" || raw === "dark" ? raw : null;
}

/**
 * Pull the preference out of a whole `document.cookie` string.
 *
 * Split rather than matched with a regular expression, so the cookie name is
 * used as the literal it is — building a pattern from a constant containing a
 * `.` invites a regex that quietly matches `bamXtheme` too.
 *
 * Only the first occurrence is considered, which is what a browser would send
 * for the most specific path anyway.
 */
export function readThemePreference(cookies: string): ThemePreference | null {
  for (const part of cookies.split(";")) {
    const [name, ...value] = part.trim().split("=");

    if (name === THEME_PREFERENCE_COOKIE) {
      return parseThemePreference(value.join("="));
    }
  }

  return null;
}
