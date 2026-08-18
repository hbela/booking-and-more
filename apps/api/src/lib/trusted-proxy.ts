import { isIP } from "node:net";

/**
 * The production API has exactly one reverse-proxy hop (Coolify's Traefik).
 * Trust forwarding headers only when that immediate peer is on the private
 * container network. A directly exposed public socket therefore cannot turn a
 * caller-supplied X-Forwarded-For value into a fresh rate-limit identity.
 */
export function trustImmediatePrivateProxy(address: string, hop: number): boolean {
  return hop === 0 && isPrivateOrLoopback(address);
}

export function isPrivateOrLoopback(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/u, "");

  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map(Number);
    const first = octets[0];
    const second = octets[1];
    return (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }

  if (isIP(normalized) === 6) {
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }

  return false;
}
