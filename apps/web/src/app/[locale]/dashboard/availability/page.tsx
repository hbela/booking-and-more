import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AvailabilityScreen } from "@/components/availability-screen";

export default async function AvailabilityPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "availability" });

  // The screen reads `?providerId=` — a provider's row on the Providers screen
  // passes it — and `useSearchParams` in a client component needs a Suspense
  // boundary above it, or the route cannot be prerendered at all.
  return (
    <Suspense fallback={<p className="p-8">{t("loading")}</p>}>
      <AvailabilityScreen />
    </Suspense>
  );
}
