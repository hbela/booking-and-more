import { setRequestLocale } from "next-intl/server";
import { ProvidersScreen } from "@/components/providers-screen";

/** Client-rendered, like the rest of the dashboard: behind a session cookie and
 *  of no SEO value. tech-impl §28. */
export default async function ProvidersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);

  return <ProvidersScreen />;
}
