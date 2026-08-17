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

  /**
   * The eleven problems that stopped the first Hetzner deployment from booting
   * an API container, reproduced verbatim.
   *
   * Coolify imports every variable named in the compose file into its own
   * environment manager and writes each into the env file it runs compose
   * with, so a key nobody filled in arrives as "" rather than absent. Before
   * `dropEmptyValues`, each of these was a boot failure over a feature the
   * operator had deliberately not configured (rule 4), and the numeric ones
   * were the least obvious: `Number("")` is 0, so a blank line beat a default
   * two lines away in the schema with "expected number to be >0".
   *
   * docs/phase-10-deployment-hetzner-coolify.md §2.6.
   */
  it("treats an empty value as not configured, the way a deployment platform sends it", () => {
    const env = load({
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      INVITATION_EXPIRY_HOURS: "",
      BOOKING_REMINDER_LEAD_HOURS: "",
      ONBOARDING_WINDOW_DAYS: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      STRIPE_PRICE_STARTER: "",
      STRIPE_PRICE_PROFESSIONAL: "",
      TRIAL_PERIOD_DAYS: "",
      SENTRY_DSN: "",
      REDIS_URL: "",
      RESEND_API_KEY: "",
      EMAIL_FROM: "",
    });

    // Optional means off, not broken.
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();

    // Defaults survive a blank line, which is the half that read as absurd:
    // the schema carries 168 and 30 and reported them as too small.
    expect(env.INVITATION_EXPIRY_HOURS).toBe(168);
    expect(env.TRIAL_PERIOD_DAYS).toBe(30);
    expect(env.ONBOARDING_WINDOW_DAYS).toBe(14);
    expect(env.BOOKING_REMINDER_LEAD_HOURS).toBe(24);
  });

  it("still refuses a half-configured pair when only one side is blank", () => {
    // Blank-as-absent must not weaken the paired-key checks: an API key with
    // no sender is still the failure those exist to catch.
    expect(() => load({ RESEND_API_KEY: "re_live_key", EMAIL_FROM: "" })).toThrow(
      EnvValidationError,
    );
    expect(() => load({ STRIPE_SECRET_KEY: "sk_live_key", STRIPE_WEBHOOK_SECRET: "" })).toThrow(
      EnvValidationError,
    );
  });

  it("still requires a required variable that arrives blank", () => {
    // The other direction: blank must not become a way to skip DATABASE_URL.
    expect(() => load({ DATABASE_URL: "" })).toThrow(EnvValidationError);
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

  /**
   * A password containing `/` does not make a connection string invalid — it
   * makes it a *different* string. `postgresql://postgres:ab/cd@host:5432/db`
   * parses cleanly to host `postgres:ab`, and the first symptom is a connection
   * error naming a host nobody typed.
   *
   * Which is not hypothetical: docs/phase-10-deployment-hetzner-coolify.md §5.4
   * told the operator to generate POSTGRES_PASSWORD with `openssl rand -base64
   * 24`, whose alphabet includes `/`. The password rotation that followed the
   * §2.9 exposure is exactly when you would draw one and least want to debug it.
   */
  describe("credentials embedded in connection strings", () => {
    it("rejects a DATABASE_URL whose password broke the authority", () => {
      expect(() =>
        load({ DATABASE_URL: "postgresql://postgres:ab/cd@localhost:5432/booking_and_more" }),
      ).toThrowError(/openssl rand -hex/);
    });

    it("rejects a REDIS_URL whose password broke the authority", () => {
      expect(() => load({ REDIS_URL: "redis://default:aa+bb/cc@localhost:6379" })).toThrowError(
        /openssl rand -hex/,
      );
    });

    it("accepts hex passwords, and percent-encoded ones", () => {
      const env = load({
        DATABASE_URL: "postgresql://postgres:6f2b9c@localhost:5432/booking_and_more",
        REDIS_URL: "redis://default:ab%2Fcd@localhost:6379",
      });

      expect(env.REDIS_URL).toBe("redis://default:ab%2Fcd@localhost:6379");
    });

    it("still accepts a Redis URL with no credentials at all", () => {
      expect(load({ REDIS_URL: "redis://localhost:6379" }).REDIS_URL).toBe(
        "redis://localhost:6379",
      );
    });
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

  /**
   * docs/phase-6-google-calendar-part-1.md §2.5 and §4.
   *
   * Sign-in and Calendar share one Google project but are separately optional,
   * and the asymmetry is the thing to get right: sign-in without Calendar is
   * ordinary, Calendar without sign-in credentials is impossible, and a redirect
   * URI without an encryption key is the dangerous one.
   */
  describe("Google Calendar", () => {
    const calendar = {
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_REDIRECT_URI: "https://api.example.com/v1/integrations/google/callback",
      GOOGLE_TOKEN_ENCRYPTION_KEY: "a".repeat(64),
    } satisfies NodeJS.ProcessEnv;

    it("accepts the full set", () => {
      const env = load(calendar);

      expect(env.GOOGLE_REDIRECT_URI).toBe(calendar.GOOGLE_REDIRECT_URI);
      expect(env.CALENDAR_OAUTH_STATE_TTL_MINUTES).toBe(15);
      expect(env.CALENDAR_MAX_ATTEMPTS).toBe(8);
      expect(env.CALENDAR_SWEEP_INTERVAL_MS).toBe(60_000);
    });

    it("leaves Calendar unconfigured when nothing is set", () => {
      expect(load().GOOGLE_REDIRECT_URI).toBeUndefined();
      expect(load().GOOGLE_TOKEN_ENCRYPTION_KEY).toBeUndefined();
    });

    it("still allows Google sign-in with no Calendar configuration", () => {
      // The common deployment: Google login, no calendar sync. It must not be
      // made harder by the calendar work.
      const env = load({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" });

      expect(env.GOOGLE_CLIENT_ID).toBe("id");
      expect(env.GOOGLE_REDIRECT_URI).toBeUndefined();
    });

    it("refuses a redirect URI with no encryption key", () => {
      // The dangerous half-configuration: consent succeeds, the provider grants
      // access, and only then can the callback not seal what it was handed —
      // a failure after the irreversible step.
      expect(() =>
        load({ ...calendar, GOOGLE_TOKEN_ENCRYPTION_KEY: undefined }),
      ).toThrowError(/GOOGLE_TOKEN_ENCRYPTION_KEY/);
    });

    it("refuses an encryption key with no redirect URI", () => {
      expect(() => load({ ...calendar, GOOGLE_REDIRECT_URI: undefined })).toThrowError(
        /GOOGLE_REDIRECT_URI/,
      );
    });

    it("names the client credentials when Calendar is configured without them", () => {
      // "Why does Connect return 503" is otherwise answered by reading four
      // variables and guessing which one is missing.
      expect(() =>
        load({ ...calendar, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined }),
      ).toThrowError(/GOOGLE_CLIENT_ID/);
    });

    it("rejects an encryption key that is not 64 hex characters", () => {
      // Caught at boot rather than at the first OAuth callback, which is the one
      // moment a provider is watching.
      for (const bad of ["a".repeat(63), "z".repeat(64), Buffer.alloc(32).toString("base64")]) {
        expect(() => load({ ...calendar, GOOGLE_TOKEN_ENCRYPTION_KEY: bad })).toThrowError(
          /64 hex characters/,
        );
      }
    });
  });
});
