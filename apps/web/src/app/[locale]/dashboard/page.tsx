import { setRequestLocale } from "next-intl/server";
import { Dashboard } from "@/components/dashboard";

/**
 * Client-rendered on purpose: it is behind a session cookie, has no SEO value,
 * and server-rendering it would mean forwarding the cookie to the API on every
 * navigation. The public booking flow (Epic 4) is the opposite case.
 */
export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);

  return <Dashboard />;
}
