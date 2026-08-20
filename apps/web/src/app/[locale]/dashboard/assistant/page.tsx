import { setRequestLocale } from "next-intl/server";
import { AssistantScreen } from "@/components/assistant-screen";

export default async function AssistantPage({ params }: { params: Promise<{ locale: string }> }): Promise<React.ReactElement> {
  setRequestLocale((await params).locale);
  return <AssistantScreen />;
}
