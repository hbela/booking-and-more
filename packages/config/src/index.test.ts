import { describe, expect, it } from "vitest";
import { EnvValidationError, loadEnv } from "./index.js";

const valid = {
  NODE_ENV: "test",
  APP_BASE_URL: "http://localhost:3000",
  API_BASE_URL: "http://localhost:3001",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/booking_and_more_test",
  BETTER_AUTH_SECRET: "a-test-secret-that-is-at-least-32-characters",
} satisfies NodeJS.ProcessEnv;

const load = (overrides: NodeJS.ProcessEnv = {}) =>
  loadEnv({ source: { ...valid, ...overrides }, loadDotenvFile: false });

describe("loadEnv", () => {
  it("accepts a minimal valid environment and applies defaults", () => {
    const env = load();

    expect(env.NODE_ENV).toBe("test");
    expect(env.PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.BOOKING_HOLD_DURATION_SECONDS).toBe(300);
    expect(env.VOICE_AUDIO_RETENTION_ENABLED).toBe(false);
  });

  it("leaves Redis undefined when unset — it is optional until Epic 5", () => {
    expect(load().REDIS_URL).toBeUndefined();
  });

  it("names the missing variable when DATABASE_URL is absent", () => {
    let thrown: unknown;
    try {
      load({ DATABASE_URL: undefined });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EnvValidationError);
    expect((thrown as EnvValidationError).message).toContain("DATABASE_URL");
    expect((thrown as EnvValidationError).message).toContain(".env.example");
  });

  it("reports every problem at once rather than only the first", () => {
    let thrown: unknown;
    try {
      load({ DATABASE_URL: undefined, APP_BASE_URL: undefined, API_BASE_URL: "not-a-url" });
    } catch (error) {
      thrown = error;
    }

    const problems = (thrown as EnvValidationError).problems;
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toContain("DATABASE_URL");
    expect(problems.join("\n")).toContain("APP_BASE_URL");
    expect(problems.join("\n")).toContain("API_BASE_URL");
  });

  it("rejects a Prisma Accelerate URL with an explanation", () => {
    expect(() =>
      load({ DATABASE_URL: "prisma+postgres://accelerate.prisma-data.net/?api_key=x" }),
    ).toThrowError(/Accelerate/);
  });

  it("coerces numeric strings", () => {
    expect(load({ PORT: "8080" }).PORT).toBe(8080);
  });

  it("rejects an out-of-range port", () => {
    expect(() => load({ PORT: "99999" })).toThrowError(EnvValidationError);
  });

  it("parses VOICE_AUDIO_RETENTION_ENABLED into a real boolean", () => {
    expect(load({ VOICE_AUDIO_RETENTION_ENABLED: "true" }).VOICE_AUDIO_RETENTION_ENABLED).toBe(
      true,
    );
    expect(load({ VOICE_AUDIO_RETENTION_ENABLED: "false" }).VOICE_AUDIO_RETENTION_ENABLED).toBe(
      false,
    );
  });

  describe("authentication config", () => {
    it("requires a signing secret", () => {
      expect(() => load({ BETTER_AUTH_SECRET: undefined })).toThrowError(/BETTER_AUTH_SECRET/);
    });

    it("rejects a short signing secret", () => {
      // A weak secret here undermines every session cookie the platform issues,
      // so this is a hard floor rather than advice.
      expect(() => load({ BETTER_AUTH_SECRET: "too-short" })).toThrowError(/32 characters/);
    });

    it("accepts Google credentials when both halves are present", () => {
      const env = load({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" });
      expect(env.GOOGLE_CLIENT_ID).toBe("id");
    });

    it("leaves Google unconfigured when neither half is present", () => {
      expect(load().GOOGLE_CLIENT_ID).toBeUndefined();
    });

    it("rejects a half-configured Google provider", () => {
      // Registering the provider with a missing half would fail at Google with
      // an opaque error, so it is caught at boot instead.
      expect(() => load({ GOOGLE_CLIENT_ID: "id" })).toThrowError(/GOOGLE_CLIENT_SECRET/);
      expect(() => load({ GOOGLE_CLIENT_SECRET: "secret" })).toThrowError(/GOOGLE_CLIENT_ID/);
    });

    it("defaults invitation expiry to seven days", () => {
      expect(load().INVITATION_EXPIRY_HOURS).toBe(168);
    });
  });
});
