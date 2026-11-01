/**
 * The sample clinic website the home page points prospects at
 * (docs/customer-onboarding-and-website-links.md §2.1): `demo/wellness`,
 * deployed as its own Coolify resource. A constant rather than configuration,
 * like the hosting provider: it is ours, public and not personal.
 */
export const DEMO_SITE_URL = "https://wellness-demo.appointer.hu";

/** Hungarian at the root, English under `/en/`, as the demo serves them. */
export function demoSiteUrl(locale: string): string {
  return locale === "en" ? `${DEMO_SITE_URL}/en/` : `${DEMO_SITE_URL}/`;
}
