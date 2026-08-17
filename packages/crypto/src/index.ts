/**
 * @bam/crypto — authenticated encryption for credentials at rest.
 * docs/phase-6-google-calendar-part-1.md §2.5.
 *
 * One job, deliberately: sealing and opening third-party tokens, plus the
 * constant-time comparison their neighbouring hashed values need. It is **not**
 * a general crypto utility belt — password hashing belongs to Better Auth, and
 * the booking management token's SHA-256 hashing already lives beside the code
 * that mints it (phase-4 §3.3).
 *
 * Node only. `node:crypto` does not ship to a browser, which is why this is not
 * a corner of `@bam/contracts`.
 */

export {
  looksSealed,
  openToken,
  parseEncryptionKey,
  safeEquals,
  sealToken,
  type SealedToken,
} from "./token-cipher.js";
