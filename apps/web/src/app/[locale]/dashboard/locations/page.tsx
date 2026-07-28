import { setRequestLocale } from "next-intl/server";
import { LocationsScreen } from "@/components/locations-screen";

export default async function LocationsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);

  return <LocationsScreen />;
}
