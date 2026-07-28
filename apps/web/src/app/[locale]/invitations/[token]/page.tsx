import { setRequestLocale } from "next-intl/server";
import { AcceptInvitation } from "@/components/accept-invitation";

export default async function AcceptInvitationPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}): Promise<React.ReactElement> {
  const { locale, token } = await params;
  setRequestLocale(locale);

  return <AcceptInvitation token={token} />;
}
