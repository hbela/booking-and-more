import createMiddleware from "next-intl/middleware";
import type { NextRequest } from "next/server";
import { isTenantPath, routing } from "./i18n/routing";

/**
 * Two middlewares, one difference: whether the browser's language may redirect.
 *
 * next-intl detects a locale from `Accept-Language` and the `NEXT_LOCALE` cookie
 * and redirects to it. That is right for **our** screens — the dashboard, sign-in,
 * the platform console are ours, and a person reading them should get their own
 * language.
 *
 * It is wrong for a **tenant's** booking page. A Hungarian clinic's page opened
 * in English because the visitor's laptop is set to English is not a
 * localisation, it is the wrong page: the services are named in Hungarian, the
 * assistant answers in whatever the page says, and the clinic never chose any of
 * it. So detection is switched off there and the language is decided one layer
 * down, in `app/[locale]/[tenantSlug]/book/page.tsx`, where the tenant's own
 * `defaultLanguage` is actually knowable.
 *
 * It has to happen here rather than only in the page: with detection on, a page
 * redirecting `/en/medicare/book` → `/medicare/book` would be sent straight back
 * by the middleware, forever.
 */
const withDetection = createMiddleware(routing);
const withoutDetection = createMiddleware({ ...routing, localeDetection: false });

export default function proxy(request: NextRequest) {
  return isTenantPath(request.nextUrl.pathname)
    ? withoutDetection(request)
    : withDetection(request);
}

export const config = {
  // Skip API routes, Next internals, and any path containing a dot (static
  // files). The backslash must be escaped: this is a string, not a regex
  // literal, so "\." would collapse to "." and match any character.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
