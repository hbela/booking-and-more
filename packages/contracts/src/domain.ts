import { z } from "zod";

/**
 * The business's own domain — `wellness.hu` — which identifies an organization.
 * docs/phase-9-saas-administration.md §2.3.
 *
 * A unique constraint on a value users type is only as good as its
 * normalisation. `WWW.Wellness.HU/`, `https://wellness.hu`, and `wellness.hu `
 * are one business, and a database that thinks they are three will happily
 * provision the same prospect three times — which is precisely the mistake the
 * constraint exists to prevent.
 *
 * `booking-for-all` had `Organization.domain String? @unique` with no
 * normalisation and no requirement, so the guarantee held only for whichever
 * rows happened to be typed consistently.
 */

/**
 * Labels separated by dots, each alphanumeric with internal hyphens, and a TLD
 * of at least two letters.
 *
 * Deliberately not an RFC-complete matcher. This rejects what is obviously not
 * a domain — a URL with a path, an email address, an IP, a bare hostname with
 * no dot — and accepts the rest. Anything subtler than that is a question for
 * DNS, not for a regex, and pretending otherwise produces a pattern nobody can
 * read and which is still wrong.
 */
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const DOMAIN_MESSAGE =
  "must be a bare domain such as wellness.hu — no scheme, no path, no www.";

/**
 * Reduce a typed domain to its canonical form, or undefined if it is not one.
 *
 * Strips, in order: surrounding whitespace, a scheme, credentials, a path or
 * query, a port, a trailing dot, and a leading `www.`.
 *
 * `www.` is removed rather than preserved because `www.wellness.hu` and
 * `wellness.hu` are the same organization to everyone except a string
 * comparison. The cost is that a business genuinely operating only on the `www`
 * host is stored without it, which affects nothing here — this value is an
 * identifier, not a URL we fetch.
 */
export function normalizeDomain(value: string): string | undefined {
  let domain = value.trim().toLowerCase();

  if (domain === "") return undefined;

  const withoutScheme = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//u, "");
  const hadScheme = withoutScheme !== domain;
  domain = withoutScheme;

  // Credentials, but only inside a URL. A bare `owner@wellness.hu` is an email
  // address someone pasted into the wrong field, and stripping the local part
  // would silently turn `owner@gmail.com` into an organization identified by
  // gmail.com. Rejecting it is the only safe reading.
  if (hadScheme) {
    domain = domain.replace(/^[^/@]*@/u, "");
  } else if (domain.includes("@")) {
    return undefined;
  }
  // path, query or fragment
  domain = domain.split(/[/?#]/u)[0] ?? "";
  // port
  domain = domain.replace(/:\d+$/u, "");
  // fully-qualified trailing dot
  domain = domain.replace(/\.$/u, "");
  // the www host is not a different business
  domain = domain.replace(/^www\./u, "");

  if (!DOMAIN_PATTERN.test(domain)) return undefined;

  // Guards the database column and keeps the failure here rather than at INSERT.
  if (domain.length > 253) return undefined;

  return domain;
}

/**
 * Accepts what a human types and yields the canonical form.
 *
 * Transforming inside the schema rather than in the handler means every route
 * that takes a domain stores the same thing, and the OpenAPI document describes
 * one `Domain` rather than several near-misses.
 */
export const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .transform((value, ctx) => {
    const normalized = normalizeDomain(value);

    if (normalized === undefined) {
      ctx.addIssue({ code: "custom", message: DOMAIN_MESSAGE });
      return z.NEVER;
    }

    return normalized;
  });
