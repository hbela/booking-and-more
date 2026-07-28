import { describe, expect, it } from "vitest";
import { EnvValidationError, loadEnv } from "./index.js";

const valid = {
  NODE_ENV: "test",
  APP_BASE_URL: "http://localhost:3000",
  API_BASE_URL: "http://localhost:3001",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/booking_and_more_test",
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
});
