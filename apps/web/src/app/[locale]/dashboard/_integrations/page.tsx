import { setRequestLocale } from "next-intl/server";
import { IntegrationsScreen } from "@/components/integrations-screen";

export default async function IntegrationsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);

  return <IntegrationsScreen />;
}
