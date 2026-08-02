import { setRequestLocale } from "next-intl/server";
import { AdminScreen } from "@/components/admin-screen";

/**
 * Where a platform administrator arrives after signing in, and where they are
 * returned after signing out.
 *
 * Client-rendered for the same reason as `/dashboard`: it is behind a session
 * cookie and has no SEO value. Hungarian is the unprefixed `/admin` and English
 * `/en/admin` — `localePrefix: "as-needed"` (src/i18n/routing.ts).
 */
export default async function AdminPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);

  return <AdminScreen />;
}
