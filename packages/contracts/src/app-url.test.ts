import { describe, expect, it } from "vitest";

import {
  APP_LOCALES,
  buildAppUrl,
  DEFAULT_APP_LOCALE,
  isAppLocale,
  resolveAppLocale,
} from "./app-url.js";

const BASE = "http://localhost:3000";

describe("buildAppUrl", () => {
  it("prefixes every locale except the default one", () => {
    // `localePrefix: "as-needed"` — the bare path *is* the Hungarian URL, which
    // is why building one without a locale was not visibly broken until an
    // English owner was provisioned.
    expect(buildAppUrl({ baseUrl: BASE, path: "/dashboard/subscription", locale: "hu" })).toBe(
      "http://localhost:3000/dashboard/subscription",
    );

    expect(buildAppUrl({ baseUrl: BASE, path: "/dashboard/subscription", locale: "en" })).toBe(
      "http://localhost:3000/en/dashboard/subscription",
    );
  });

  it("falls back to the default locale rather than interpolating an unknown one", () => {
    // `Tenant.defaultLanguage` is a plain string column. A wrong-language page
    // is recoverable by whoever lands on it; `/de junk/dashboard` is not.
    for (const value of ["de", "", "   ", "nonsense", null, undefined]) {
      expect(buildAppUrl({ baseUrl: BASE, path: "/dashboard", locale: value })).toBe(
        "http://localhost:3000/dashboard",
      );
    }
  });

  it("accepts region subtags and casing", () => {
    expect(buildAppUrl({ baseUrl: BASE, path: "/dashboard", locale: "EN-GB" })).toBe(
      "http://localhost:3000/en/dashboard",
    );
    expect(buildAppUrl({ baseUrl: BASE, path: "/dashboard", locale: "hu_HU" })).toBe(
      "http://localhost:3000/dashboard",
    );
  });

  it("tolerates a trailing slash on the base and a missing one on the path", () => {
    expect(
      buildAppUrl({ baseUrl: "http://localhost:3000/", path: "dashboard", locale: "en" }),
    ).toBe("http://localhost:3000/en/dashboard");
  });

  it("keeps query strings and fragments intact", () => {
    expect(buildAppUrl({ baseUrl: BASE, path: "/invitations/abc?from=email", locale: "en" })).toBe(
      "http://localhost:3000/en/invitations/abc?from=email",
    );
  });
});

describe("resolveAppLocale", () => {
  it("agrees with isAppLocale on every routed locale", () => {
    for (const locale of APP_LOCALES) {
      expect(isAppLocale(locale)).toBe(true);
      expect(resolveAppLocale(locale)).toBe(locale);
    }
  });

  it("holds the same locales the rest of the platform does", () => {
    // Three lists exist by design — apps/web/src/i18n/routing.ts routes them,
    // @bam/notification-engine has templates for them, and this package builds
    // URLs to them — and none of the three may import the others. This is the
    // one place they are asserted to be the same set, so drift is a failing
    // test rather than an email linking to a 404.
    expect([...APP_LOCALES].sort()).toEqual(["en", "hu"]);
    expect(DEFAULT_APP_LOCALE).toBe("hu");
  });
});
