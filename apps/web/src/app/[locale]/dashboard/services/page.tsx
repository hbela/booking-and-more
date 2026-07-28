import { setRequestLocale } from "next-intl/server";
import { ServicesScreen } from "@/components/services-screen";

export default async function ServicesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);

  return <ServicesScreen />;
}
