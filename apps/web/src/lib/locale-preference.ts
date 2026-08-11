/**
 * Has this visitor chosen a language, or are we still guessing for them?
 *
 * next-intl writes `NEXT_LOCALE` as part of resolving a request, so its presence
 * says nothing about intent — after the first page view every visitor has one.
 * This is our own cookie and it is written in exactly one place: the locale
 * switcher, when somebody uses it. So it means what it says.
 *
 * The distinction is what stops the booking page fighting its own visitor. The
 * tenant's language is the right default; it must not be re-applied over the top
 * of a customer who has just asked for something else.
 */
export const LOCALE_PREFERENCE_COOKIE = "bam.locale";

/** A year. A language preference is not something to ask twice in a session. */
export const LOCALE_PREFERENCE_MAX_AGE = 60 * 60 * 24 * 365;
