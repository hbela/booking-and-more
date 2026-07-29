import { setRequestLocale } from "next-intl/server";
import { AvailabilityScreen } from "@/components/availability-screen";

export default async function AvailabilityPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);

  return <AvailabilityScreen />;
}
