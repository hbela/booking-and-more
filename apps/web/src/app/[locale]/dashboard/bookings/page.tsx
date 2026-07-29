import { setRequestLocale } from "next-intl/server";
import { BookingsScreen } from "@/components/bookings-screen";

export default async function BookingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);

  return <BookingsScreen />;
}
