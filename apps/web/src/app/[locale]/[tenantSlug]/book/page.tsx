import { setRequestLocale } from "next-intl/server";
import { BookingFlow } from "@/components/booking-flow";

/**
 * A clinic's public booking page. tech-impl §28.
 *
 * `/[tenantSlug]/book` rather than the six sub-routes §28 lists — see the note
 * at the top of BookingFlow for why the steps are state rather than navigation.
 */
export default async function BookPage({
  params,
}: {
  params: Promise<{ locale: string; tenantSlug: string }>;
}): Promise<React.ReactElement> {
  const { locale, tenantSlug } = await params;
  setRequestLocale(locale);

  return <BookingFlow tenantSlug={tenantSlug} />;
}
