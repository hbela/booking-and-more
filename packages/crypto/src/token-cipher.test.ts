import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  looksSealed,
  openToken,
  parseEncryptionKey,
  safeEquals,
  sealToken,
} from "./token-cipher.js";

/**
 * The failures worth naming here are not "does it round-trip" — that is one
 * line. They are the ones that would let a broken credential look like a
 * working one, or a tampered one look authentic.
 */

const KEY_HEX = "a".repeat(64);
const KEY = parseEncryptionKey(KEY_HEX);
const OTHER_KEY = parseEncryptionKey("b".repeat(64));

const TOKEN = "1//0gW7xExampleRefreshTokenFromGoogle_with-symbols";

describe("parseEncryptionKey", () => {
  it("accepts 64 hex characters, in either case", () => {
    expect(parseEncryptionKey("A".repeat(64))).toHaveLength(32);
    expect(parseEncryptionKey("0123456789abcdef".repeat(4))).toHaveLength(32);
  });

  it.each([
    ["too short", "a".repeat(63)],
    ["too long", "a".repeat(65)],
    ["not hex", "z".repeat(64)],
    ["base64 of 32 bytes, the plausible wrong answer", randomBytes(32).toString("base64")],
    ["empty", ""],
  ])("refuses a key that is %s", (_label, value) => {
    expect(() => parseEncryptionKey(value)).toThrow(/64 hex characters/u);
  });

  it("never puts the key in the error", () => {
    // The message is read by a human staring at a failed boot, and boot errors
    // get pasted into chat windows.
    const secret = "c".repeat(63);
    expect(() => parseEncryptionKey(secret)).toThrow(expect.not.stringContaining(secret));
  });
});

describe("sealToken / openToken", () => {
  it("round-trips", () => {
    expect(openToken(sealToken(TOKEN, KEY), KEY)).toBe(TOKEN);
  });

  it("round-trips a token with multibyte characters", () => {
    const accented = "tokén-ünnepnap-💾";
    expect(openToken(sealToken(accented, KEY), KEY)).toBe(accented);
  });

  it("produces a different ciphertext every time", () => {
    // The IV is fresh per call, which is not a nicety: a reused IV under one key
    // breaks GCM outright. The visible consequence is that a sealed value can
    // never be compared for equality, and nothing may index one.
    const first = sealToken(TOKEN, KEY);
    const second = sealToken(TOKEN, KEY);

    expect(first).not.toBe(second);
    expect(openToken(first, KEY)).toBe(openToken(second, KEY));
  });

  it("does not contain the plaintext", () => {
    // The cheap assertion that catches "forgot to seal" wherever it is made.
    expect(sealToken(TOKEN, KEY)).not.toContain(TOKEN);
    expect(sealToken(TOKEN, KEY)).not.toContain("RefreshToken");
  });

  it("refuses to seal an empty string", () => {
    // An empty token means the caller has already lost the value; sealing it
    // would store a convincing-looking credential that can never work.
    expect(() => sealToken("", KEY)).toThrow(/empty token/u);
  });

  it("refuses a key of the wrong size", () => {
    expect(() => sealToken(TOKEN, randomBytes(16))).toThrow(/32 bytes/u);
    expect(() => openToken(sealToken(TOKEN, KEY), randomBytes(31))).toThrow(/32 bytes/u);
  });
});

describe("openToken rejects what it should", () => {
  it("refuses a different key", () => {
    expect(() => openToken(sealToken(TOKEN, KEY), OTHER_KEY)).toThrow(/failed authentication/u);
  });

  it("refuses a tampered ciphertext", () => {
    // The whole reason for GCM over CBC: altering the ciphertext must fail
    // loudly, not decrypt to plausible rubbish that then gets sent to Google.
    const sealed = sealToken(TOKEN, KEY);
    const parts = sealed.split(".");
    const bytes = Buffer.from(parts[2]!, "base64url");
    bytes[0] = bytes[0]! ^ 0xff;
    parts[2] = bytes.toString("base64url");

    expect(() => openToken(parts.join("."), KEY)).toThrow(/failed authentication/u);
  });

  it("refuses a tampered auth tag", () => {
    const parts = sealToken(TOKEN, KEY).split(".");
    const tag = Buffer.from(parts[3]!, "base64url");
    tag[0] = tag[0]! ^ 0xff;
    parts[3] = tag.toString("base64url");

    expect(() => openToken(parts.join("."), KEY)).toThrow(/failed authentication/u);
  });

  it.each([
    ["a plaintext somebody stored by mistake", TOKEN],
    ["an unknown version", "v2.AAAA.AAAA.AAAA"],
    ["too few parts", "v1.AAAA.AAAA"],
    ["an empty string", ""],
    ["an iv of the wrong length", `v1.${Buffer.alloc(8).toString("base64url")}.AAAA.AAAA`],
  ])("refuses %s", (_label, value) => {
    expect(() => openToken(value, KEY)).toThrow(/malformed|unsupported|failed authentication/u);
  });

  it("reports the same failure for a wrong key and a tampered value", () => {
    // Deliberate: a decryption oracle that distinguishes failure modes is how
    // padding-oracle attacks start, and no caller here could act differently.
    const parts = sealToken(TOKEN, KEY).split(".");
    const tag = Buffer.from(parts[3]!, "base64url");
    tag[0] = tag[0]! ^ 0xff;
    parts[3] = tag.toString("base64url");

    const wrongKey = catchMessage(() => openToken(sealToken(TOKEN, KEY), OTHER_KEY));
    const tampered = catchMessage(() => openToken(parts.join("."), KEY));

    expect(wrongKey).toBe(tampered);
  });
});

describe("looksSealed", () => {
  it("tells a sealed value from a plaintext one", () => {
    expect(looksSealed(sealToken(TOKEN, KEY))).toBe(true);
    expect(looksSealed(TOKEN)).toBe(false);
    expect(looksSealed("")).toBe(false);
  });

  it("is structural only and says nothing about authenticity", () => {
    // Named because the shape invites the opposite assumption.
    expect(looksSealed("v1.a.b.c")).toBe(true);
    expect(() => openToken("v1.a.b.c", KEY)).toThrow();
  });
});

describe("safeEquals", () => {
  it("compares equal and unequal buffers", () => {
    expect(safeEquals(Buffer.from("abc"), Buffer.from("abc"))).toBe(true);
    expect(safeEquals(Buffer.from("abc"), Buffer.from("abd"))).toBe(false);
  });

  it("returns false rather than throwing on a length mismatch", () => {
    // `timingSafeEqual` throws on unequal lengths, and that throw would itself
    // be the signal the function exists to avoid leaking.
    expect(safeEquals(Buffer.from("abc"), Buffer.from("abcd"))).toBe(false);
  });
});

function catchMessage(run: () => unknown): string {
  try {
    run();
    return "did not throw";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
