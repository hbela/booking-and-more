import { apiFetch, type MeResponse, type TenantSummary } from "./api-client";

export class TenantLoginDenied extends Error {}

/** A slug identifies the requested tenant; the API remains the authority on membership. */
export async function enterTenant(
  slug: string,
  request: typeof apiFetch = apiFetch,
): Promise<"/admin" | "/dashboard"> {
  const me = await request<MeResponse>("/v1/me");
  if (me.user.isPlatformAdmin) return "/admin";

  const { items } = await request<{ items: TenantSummary[] }>("/v1/tenants");
  const tenant = items.find((item) => item.slug === slug);
  if (!tenant) throw new TenantLoginDenied("No membership in the requested tenant.");

  await request(`/v1/tenants/${encodeURIComponent(tenant.id)}/activate`, { method: "POST" });
  return "/dashboard";
}
