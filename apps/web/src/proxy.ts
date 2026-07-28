import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

export default createMiddleware(routing);

export const config = {
  // Skip API routes, Next internals, and any path containing a dot (static
  // files). The backslash must be escaped: this is a string, not a regex
  // literal, so "\." would collapse to "." and match any character.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
