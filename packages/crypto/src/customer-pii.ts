import { createHmac } from "node:crypto";
import { openToken, parseEncryptionKey, sealToken } from "./token-cipher.js";

/** Customer fields only; null remains null and empty optional values remain empty. */
export function createCustomerPii(encryptionHex: string, indexHex: string) {
  const encryptionKey = parseEncryptionKey(encryptionHex);
  const indexKey = parseEncryptionKey(indexHex);
  if (encryptionKey.equals(indexKey)) throw new Error("Customer PII keys must be distinct.");
  return {
    seal(value: string): string {
      // A tagged JSON string supports empty values without relaxing token encryption.
      return sealToken(JSON.stringify(value), encryptionKey);
    },
    open(value: string): string {
      const decoded: unknown = JSON.parse(openToken(value, encryptionKey));
      if (typeof decoded !== "string") throw new Error("Invalid customer PII envelope.");
      return decoded;
    },
    sealNullable(value: string | null): string | null {
      return value === null ? null : this.seal(value);
    },
    openNullable(value: string | null): string | null {
      return value === null ? null : this.open(value);
    },
    index(tenantId: string, normalizedValue: string | null): string | null {
      if (!normalizedValue) return null;
      return createHmac("sha256", indexKey)
        .update(`${tenantId}\0${normalizedValue}`)
        .digest("base64url");
    },
  };
}

export type CustomerPii = ReturnType<typeof createCustomerPii>;

// Scoped to a client's lifecycle, never global keys shared between applications.
const scopes = new WeakMap<object, CustomerPii>();
export function bindCustomerPii(scope: object, pii: CustomerPii): void {
  scopes.set(scope, pii);
}
export function customerPiiFor(scope: object): CustomerPii {
  const pii = scopes.get(scope);
  if (!pii) throw new Error("Customer PII must be configured at application startup.");
  return pii;
}
