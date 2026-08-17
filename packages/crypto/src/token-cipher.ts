import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Authenticated encryption for third-party credentials at rest.
 * tech-impl §25.2, docs/phase-6-google-calendar-part-1.md §2.5.
 *
 * A Google refresh token is a bearer credential with no expiry that can read and
 * write a person's calendar until they revoke it. PRD §9.10 requires it
 * encrypted at rest, and that is the whole job of this file.
 *
 * ## Why AES-256-GCM and not "just" AES-CBC
 *
 * GCM is *authenticated*: decryption fails loudly when the ciphertext has been
 * altered, rather than returning plausible-looking rubbish. Without that, an
 * attacker with write access to the column can flip bits and the application
 * cheerfully sends the result to Google. The auth tag is what makes
 * {@link openToken} able to say "this is not what we sealed" instead of
 * "here is a token that does not work".
 *
 * ## Why this is its own package
 *
 * Both halves of the product need it and they are different processes: the API
 * seals on the OAuth callback, the worker opens on every sync. `@bam/contracts`
 * is the other shared package and is the wrong home — it ships to the browser,
 * and `node:crypto` does not.
 *
 * ## What must never happen here
 *
 * Nothing in this file logs, and nothing returns a plaintext inside an Error
 * message. `@bam/observability`'s `REDACT_PATHS` already covers
 * `encryptedRefreshToken` and friends, but redaction is a safety net for
 * accidents, not a licence to pass secrets to a logger.
 */

/** `v1.<iv>.<ciphertext>.<tag>`, each part base64url. */
const VERSION = "v1";

/** 96 bits, the size GCM is specified for and fastest with. */
const IV_BYTES = 12;

/** GCM's tag. 128 bits — never truncate it; a short tag is a forgeable tag. */
const TAG_BYTES = 16;

/** AES-256. The key is exactly this or the constructor refuses. */
const KEY_BYTES = 32;

/**
 * A sealed token, as stored.
 *
 * Self-describing on purpose. The version prefix is what makes rotation
 * possible later without a migration that has to guess: a `v2` reader can accept
 * both, re-seal on read, and the column ends up converted by ordinary traffic.
 * A bare base64 blob would have to be decoded to find out it could not be
 * decoded.
 */
export type SealedToken = string;

/**
 * Parse and validate the key once, at the edge.
 *
 * Hex rather than base64, and the reasoning is phase-10 §2.9's the other way
 * round: a base64 key can contain `/` and `+`, which survive an env file but
 * make a value that is painful to move through shell quoting and impossible to
 * eyeball for truncation. 64 hex characters is unambiguous, and a wrong length
 * is caught here rather than at the first decryption in production.
 *
 * Generate with `openssl rand -hex 32`.
 */
export function parseEncryptionKey(value: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/u.test(value)) {
    // The key itself is never in the message — only its shape.
    throw new Error(
      `Encryption key must be 64 hex characters (32 bytes); got ${String(value.length)} characters. Generate with \`openssl rand -hex 32\`.`,
    );
  }

  return Buffer.from(value, "hex");
}

/**
 * Encrypt a token for storage.
 *
 * A fresh random IV per call, which is not optional: GCM's security collapses
 * entirely if an IV is reused under the same key — not degrades, collapses, to
 * the point of leaking the authentication key. Deriving an IV from the
 * plaintext, or counting, is the classic way to get this wrong, so it is
 * `randomBytes` and nothing else.
 *
 * The same plaintext therefore seals to a different string every time. That is
 * correct and worth knowing: **a sealed value can never be compared for
 * equality**, and nothing may put a unique index on one.
 */
export function sealToken(plaintext: string, key: Buffer): SealedToken {
  assertKey(key);

  if (plaintext === "") {
    throw new Error("Refusing to seal an empty token; the caller has lost the value.");
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, b64(iv), b64(ciphertext), b64(tag)].join(".");
}

/**
 * Decrypt a stored token.
 *
 * Throws on anything that is not exactly what we sealed — wrong key, altered
 * ciphertext, altered tag, truncated value, unknown version. Every one of those
 * is the same answer to the caller ("this credential is unusable"), and the
 * distinctions are deliberately not reported: a decryption oracle that
 * distinguishes "bad padding" from "bad tag" is how padding-oracle attacks
 * start, and there is no caller here that could act differently anyway.
 */
export function openToken(sealed: SealedToken, key: Buffer): string {
  assertKey(key);

  const parts = sealed.split(".");

  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Sealed token is malformed or of an unsupported version.");
  }

  const iv = unb64(parts[1]!);
  const ciphertext = unb64(parts[2]!);
  const tag = unb64(parts[3]!);

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Sealed token is malformed or of an unsupported version.");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // `final()` throws when the tag does not verify. Deliberately swallowed and
    // rethrown flat: the underlying message varies by Node version and says
    // nothing a caller can use.
    throw new Error("Sealed token failed authentication; it was not sealed with this key.");
  }
}

/**
 * Is this string one of ours?
 *
 * Cheap and structural — it does **not** verify the tag, so a true answer means
 * "shaped like a sealed token", never "authentic". Its only job is to tell a
 * migration or a diagnostic apart from a plaintext that somebody stored by
 * mistake, which is exactly the failure the `not.toContain(plaintext)` test in
 * the API suite exists to catch.
 */
export function looksSealed(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts[0] === VERSION;
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Encryption key must be ${String(KEY_BYTES)} bytes; got ${String(key.length)}. Use parseEncryptionKey.`,
    );
  }
}

/**
 * Constant-time comparison, exported because callers that compare a *hashed*
 * credential need one and reaching for `===` there is the bug.
 *
 * Not used by the sealing above — GCM's tag check is already constant-time —
 * but the OAuth state row compares a SHA-256 digest, and a byte-by-byte `===`
 * on that is a timing oracle. Length is compared first because
 * `timingSafeEqual` throws on a mismatch rather than returning false, and that
 * throw would itself be the signal.
 */
export function safeEquals(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function b64(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function unb64(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
