import { describe, expect, it } from "vitest";
import { isPrivateOrLoopback, trustImmediatePrivateProxy } from "./trusted-proxy.js";

describe("trusted reverse proxy", () => {
  it.each(["127.0.0.1", "::1", "10.0.0.8", "172.20.0.4", "192.168.1.2", "fd00::5"])(
    "trusts the immediate private container peer %s",
    (address) => {
      expect(isPrivateOrLoopback(address)).toBe(true);
      expect(trustImmediatePrivateProxy(address, 0)).toBe(true);
    },
  );

  it.each(["203.0.113.10", "8.8.8.8", "2001:4860:4860::8888", "not-an-ip"])(
    "does not trust a directly connected public peer %s",
    (address) => {
      expect(isPrivateOrLoopback(address)).toBe(false);
      expect(trustImmediatePrivateProxy(address, 0)).toBe(false);
    },
  );

  it("never trusts a second forwarded hop", () => {
    expect(trustImmediatePrivateProxy("10.0.0.8", 1)).toBe(false);
  });
});
