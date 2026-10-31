import { describe, expect, it } from "vitest";
import { canonicalRedirect } from "./canonical-host";

const env = {
  APP_BASE_URL: "https://app.booking.appointer.hu",
  CANONICAL_REDIRECT_HOSTS: "booking.appointer.hu, www.booking.appointer.hu",
};

describe("canonicalRedirect", () => {
  it("sends a listed host to the same path and query on the app", () => {
    expect(
      canonicalRedirect(
        new URL("https://booking.appointer.hu/en/pricing?plan=pro"),
        "booking.appointer.hu",
        env,
      ),
    ).toBe("https://app.booking.appointer.hu/en/pricing?plan=pro");
  });

  it("ignores case and a port on the Host header", () => {
    expect(canonicalRedirect(new URL("https://x/terms"), "Booking.Appointer.hu:443", env)).toBe(
      "https://app.booking.appointer.hu/terms",
    );
  });

  it("leaves every host nobody listed alone", () => {
    expect(canonicalRedirect(new URL("https://x/"), "app.booking.appointer.hu", env)).toBeNull();
    expect(canonicalRedirect(new URL("http://x/"), "localhost:3000", env)).toBeNull();
  });

  it("does nothing until both settings exist", () => {
    expect(
      canonicalRedirect(new URL("https://x/"), "booking.appointer.hu", {
        CANONICAL_REDIRECT_HOSTS: env.CANONICAL_REDIRECT_HOSTS,
      }),
    ).toBeNull();
    expect(
      canonicalRedirect(new URL("https://x/"), "booking.appointer.hu", {
        APP_BASE_URL: env.APP_BASE_URL,
      }),
    ).toBeNull();
  });

  it("refuses to redirect the app's own host to itself", () => {
    expect(
      canonicalRedirect(new URL("https://x/"), "app.booking.appointer.hu", {
        ...env,
        CANONICAL_REDIRECT_HOSTS: "app.booking.appointer.hu",
      }),
    ).toBeNull();
  });
});
