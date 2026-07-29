import { setRequestLocale } from "next-intl/server";
import { ManageBooking } from "@/components/manage-booking";

/**
 * The link in a customer's confirmation. tech-impl §28, §34.4.
 *
 * The token in the path is the credential. It never reaches a server component
 * beyond being handed to the client, and the API stores only its hash.
 */
export default async function ManageBookingPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}): Promise<React.ReactElement> {
  const { locale, token } = await params;
  setRequestLocale(locale);

  return <ManageBooking token={token} />;
}
