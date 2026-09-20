import { API_BASE_URL } from "@/lib/api-origin";
/** Server-side public lookup: never forwards staff session credentials. */
export async function publicAppTenant(
  slug: string,
): Promise<
  | { tenant: { id: string; name: string; slug: string; features?: { assistant?: boolean } } }
  | { status: number }
> {
  const base = API_BASE_URL;
  try {
    const response = await fetch(`${base}/v1/public/tenants/${slug}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { status: response.status === 404 ? 404 : 503 };
    const tenant = (await response.json()) as {
      id: string;
      name: string;
      slug: string;
      features?: { assistant?: boolean };
    };
    if (!tenant.id || !tenant.name || tenant.slug !== slug) return { status: 503 };
    return { tenant };
  } catch {
    return { status: 503 };
  }
}
