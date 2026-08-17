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
  // Not a connection string, but it carries the Redis credentials and appears
  // in ioredis error objects.
  "options.password",
  "*.options.password",

  // Email delivery (Epic 5)
  "RESEND_API_KEY",
  "*.RESEND_API_KEY",

  // Google Calendar (Epic 6). `encryptedAccessToken`, `encryptedRefreshToken`,
  // `accessToken`, `refreshToken`, `authorizationCode` and `clientSecret` are
  // already listed above — they were added before anything could produce one.
  // These are the names Epic 6 actually introduces.
  "GOOGLE_TOKEN_ENCRYPTION_KEY",
  "*.GOOGLE_TOKEN_ENCRYPTION_KEY",
  "GOOGLE_CLIENT_SECRET",
  "*.GOOGLE_CLIENT_SECRET",
  // The sealed forms as stored, in case a row is ever logged whole. Sealed is
  // not plaintext, but a ciphertext in a log is still a ciphertext an attacker
  // no longer has to reach the database for.
  "sealedAccessToken",
  "*.sealedAccessToken",
  "sealedRefreshToken",
  "*.sealedRefreshToken",
  // The OAuth state secret: whoever holds it can complete somebody else's
  // consent flow while the row is live.
  "stateSecret",
  "*.stateSecret",

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

  // A notification's `recipient` is an email address, and it travels through
  // the dispatcher and the sender on every job. Notification rows are
  // identified in logs by id for exactly this reason (Epic 5).
  "recipient",
  "*.recipient",
  "to",
  "*.to",
];

export const REDACTED = "[redacted]";
