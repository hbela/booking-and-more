import { describe, expect, it, vi } from "vitest";
import type { apiFetch } from "./api-client";
import { enterTenant, TenantLoginDenied } from "./tenant-login";

describe("tenant-specific login", () => {
  it("matches a normalized domain independently of the tenant slug", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ user: { isPlatformAdmin: false } })
      .mockResolvedValueOnce({
        items: [
          { id: "wrong", slug: "wellness-demo", domain: "other.appointer.hu" },
          { id: "correct", slug: "wellness", domain: "wellness-demo.appointer.hu" },
        ],
      })
      .mockResolvedValueOnce(undefined);
    expect(await enterTenant("Wellness-Demo.Appointer.Hu", request as typeof apiFetch)).toBe(
      "/dashboard",
    );
    expect(request).toHaveBeenLastCalledWith("/v1/tenants/correct/activate", { method: "POST" });
  });

  it.each(["appointer.hu", "wellness-demo.appointer", "other.appointer.hu"])(
    "does not infer domain membership from a partial or different identifier: %s",
    async (identifier) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce({ user: { isPlatformAdmin: false } })
        .mockResolvedValueOnce({
          items: [{ id: "one", slug: "wellness", domain: "wellness-demo.appointer.hu" }],
        });
      await expect(enterTenant(identifier, request as typeof apiFetch)).rejects.toBeInstanceOf(
        TenantLoginDenied,
      );
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("fails closed when an older API omits the domain", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ user: { isPlatformAdmin: false } })
      .mockResolvedValueOnce({ items: [{ id: "one", slug: "wellness" }] });
    await expect(
      enterTenant("wellness-demo.appointer.hu", request as typeof apiFetch),
    ).rejects.toBeInstanceOf(TenantLoginDenied);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["OWNER", "PROVIDER", "ASSISTANT"])(
    "activates the requested membership for %s before navigating",
    async (role) => {
      let finishActivation!: () => void;
      const activation = new Promise<void>((resolve) => {
        finishActivation = resolve;
      });
      const request = vi
        .fn()
        .mockResolvedValueOnce({ user: { isPlatformAdmin: false }, tenant: { slug: "wellness" } })
        .mockResolvedValueOnce({
          items: [
            { id: "wellness-id", slug: "wellness", role },
            { id: "medicare-id", slug: "medicare", role },
          ],
        })
        .mockImplementationOnce(() => activation);
      let entered = false;
      const result = enterTenant("medicare", request as typeof apiFetch).then((path) => {
        entered = true;
        return path;
      });
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("/v1/tenants/medicare-id/activate", {
          method: "POST",
        }),
      );
      expect(entered).toBe(false);
      finishActivation();
      expect(await result).toBe("/dashboard");
    },
  );

  it("does not activate another tenant when membership is missing", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ user: { isPlatformAdmin: false } })
      .mockResolvedValueOnce({ items: [{ id: "one", slug: "wellness" }] });
    await expect(enterTenant("medicare", request as typeof apiFetch)).rejects.toBeInstanceOf(
      TenantLoginDenied,
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not navigate when activation is denied or fails", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ user: { isPlatformAdmin: false } })
      .mockResolvedValueOnce({ items: [{ id: "one", slug: "medicare" }] })
      .mockRejectedValueOnce(new Error("Membership revoked"));
    await expect(enterTenant("medicare", request as typeof apiFetch)).rejects.toThrow(
      "Membership revoked",
    );
  });

  it("does not fall back to a dashboard if the session cannot be read", async () => {
    const request = vi.fn().mockRejectedValue(new Error("Offline"));
    await expect(enterTenant("medicare", request as typeof apiFetch)).rejects.toThrow("Offline");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("sends platform administrators to admin without activating a tenant", async () => {
    const request = vi.fn().mockResolvedValueOnce({ user: { isPlatformAdmin: true } });
    expect(await enterTenant("medicare", request as typeof apiFetch)).toBe("/admin");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
