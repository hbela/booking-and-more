import { setRequestLocale } from "next-intl/server";
import { SubscriptionScreen } from "@/components/subscription-screen";

export default async function SubscriptionPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);

  return <SubscriptionScreen />;
}
