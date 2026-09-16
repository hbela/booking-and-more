import { apiFetch, type MeResponse, type TenantSummary } from "./api-client";
import { normalizeDomain } from "@bam/contracts";

export class TenantLoginDenied extends Error {}

/** Domain entry uses the stored domain; legacy slug links remain supported. */
export async function enterTenant(
  identifier: string,
  request: typeof apiFetch = apiFetch,
): Promise<"/admin" | "/dashboard"> {
  const me = await request<MeResponse>("/v1/me");
  if (me.user.isPlatformAdmin) return "/admin";

  const { items } = await request<{ items: TenantSummary[] }>("/v1/tenants");
  const domain = identifier.includes(".") ? normalizeDomain(identifier) : undefined;
  const tenant = items.find((item) =>
    identifier.includes(".")
      ? domain !== undefined && item.domain?.toLowerCase() === domain
      : item.slug === identifier,
  );
  if (!tenant) throw new TenantLoginDenied("No membership in the requested tenant.");

  await request(`/v1/tenants/${encodeURIComponent(tenant.id)}/activate`, { method: "POST" });
  return "/dashboard";
}
