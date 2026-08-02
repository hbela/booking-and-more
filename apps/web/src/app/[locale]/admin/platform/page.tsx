import { setRequestLocale } from "next-intl/server";
import { AdminShell } from "@/components/admin-shell";
import { PlatformScreen } from "@/components/platform-screen";

/**
 * The platform-admin dashboard. docs/phase-9-saas-administration.md §7.
 *
 * Deliberately outside `/dashboard`: that tree resolves a tenant from the
 * switcher and every screen inside it is scoped to one. These routes are about
 * tenants rather than within one, and share none of that chrome — they have
 * `AdminShell` instead. Moved here from `/platform`, which now redirects.
 */
export default async function AdminPlatformPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <AdminShell>
      <PlatformScreen />
    </AdminShell>
  );
}
