/**
 * Log redaction paths. CLAUDE.md rule 6.
 *
 * Configured centrally rather than scrubbed at call sites, because scrubbing at
 * call sites only works for the call sites you remembered. The predecessor
 * project logged a full connection string during a boot failure, which is how
 * this list came to exist.
 *
 * Pino applies these as exact paths, so both the top-level and the nested
 * (`req.headers.*`, `*.token`) forms need listing.
 */
export const REDACT_PATHS: readonly string[] = [
  // Credentials in flight
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "req.headers['idempotency-key']",
  "res.headers['set-cookie']",
  "headers.authorization",
  "headers.cookie",

  // Secrets at rest / in config
  "password",
  "*.password",
  "passwordHash",
  "*.passwordHash",
  "token",
  "*.token",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "encryptedAccessToken",
  "*.encryptedAccessToken",
  "encryptedRefreshToken",
  "*.encryptedRefreshToken",
  "apiKey",
  "*.apiKey",
  "secret",
  "*.secret",
  "clientSecret",
  "*.clientSecret",
  "authorizationCode",
  "*.authorizationCode",

  // Connection strings
  "DATABASE_URL",
  "*.DATABASE_URL",
  "REDIS_URL",
  "*.REDIS_URL",

  // Booking-management tokens are bearer credentials for a booking (tech-impl §34.4)
  "managementToken",
  "*.managementToken",

  // Customer PII — present in booking payloads, must not reach logs (PRD §13.3)
  "customerEmail",
  "*.customerEmail",
  "customerPhone",
  "*.customerPhone",
  "customerName",
  "*.customerName",
  "transcript",
  "*.transcript",
];

export const REDACTED = "[redacted]";
