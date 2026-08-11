import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { isTenantPath, routing } from "./routing";

/**
 * Which paths belong to a tenant, and which are ours.
 *
 * The distinction decides whether the browser's language may redirect
 * (`proxy.ts`), so getting it wrong means a Hungarian clinic's page opening in
 * English again — the bug this was written for — or the dashboard refusing to
 * follow the reader's own language.
 */

describe("isTenantPath", () => {
  it("claims a tenant's booking page, prefixed or not", () => {
    expect(isTenantPath("/medicare")).toBe(true);
    expect(isTenantPath("/medicare/book")).toBe(true);
    expect(isTenantPath("/en/medicare")).toBe(true);
    expect(isTenantPath("/en/medicare/book")).toBe(true);
    expect(isTenantPath("/hu/medicare/book")).toBe(true);
  });

  it("leaves our own screens alone", () => {
    for (const path of [
      "/dashboard",
      "/dashboard/availability",
      "/en/dashboard",
      "/sign-in",
      "/en/sign-up",
      "/platform",
      "/admin/platform",
      "/invitations/abc123",
    ]) {
      expect(isTenantPath(path), path).toBe(false);
    }
  });

  it("leaves the manage-booking link alone", () => {
    // A customer's own link, carrying whatever locale their confirmation email
    // was written in — `buildAppUrl` already put the right prefix on it.
    expect(isTenantPath("/booking/manage/abc")).toBe(false);
    expect(isTenantPath("/en/booking/manage/abc")).toBe(false);
  });

  it("does not claim the root or a locale on its own", () => {
    expect(isTenantPath("/")).toBe(false);
    expect(isTenantPath("/en")).toBe(false);
  });

  it("does not claim something deeper than a tenant page", () => {
    // Matching loosely would quietly take over any route added later.
    expect(isTenantPath("/medicare/book/extra")).toBe(false);
  });

  it("knows every directory that sits beside [tenantSlug]", () => {
    // The list in routing.ts is hand-maintained because [tenantSlug] is a
    // catch-all. This is what notices when somebody adds a route beside it:
    // a new top-level section would otherwise silently stop following the
    // reader's language.
    const appDir = fileURLToPath(new URL("../app/[locale]", import.meta.url));

    const segments = readdirSync(appDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) =>
        // Route groups — `(auth)` — are not URL segments; their children are.
        entry.name.startsWith("(")
          ? readdirSync(`${appDir}/${entry.name}`, { withFileTypes: true })
              .filter((child) => child.isDirectory())
              .map((child) => child.name)
          : [entry.name],
      )
      .filter((name) => !name.startsWith("[") && !name.startsWith("_"));

    for (const segment of segments) {
      expect(isTenantPath(`/${segment}`), `/${segment} is one of ours`).toBe(false);
    }
  });
});

describe("routing", () => {
  it("keeps Hungarian unprefixed", () => {
    // `buildAppUrl` in @bam/contracts emits the same canonical form, and the
    // tenant-language redirect in book/page.tsx assumes it.
    expect(routing.defaultLocale).toBe("hu");
    expect(routing.localePrefix).toBe("as-needed");
  });
});
