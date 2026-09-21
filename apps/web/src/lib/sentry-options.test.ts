import { describe, expect, it } from "vitest";
import { apiTraceTarget } from "./sentry-options";

describe("Sentry trace propagation", () => {
  it("allows only the configured API origin", () => {
    const target = apiTraceTarget("https://api.example.com");
    expect(target.test("https://api.example.com/v1/bookings")).toBe(true);
    expect(target.test("https://api.example.com.evil.test/v1/bookings")).toBe(false);
    expect(target.test("https://apiXexample.com/v1/bookings")).toBe(false);
    expect(target.test("http://api.example.com/v1/bookings")).toBe(false);
  });
});
