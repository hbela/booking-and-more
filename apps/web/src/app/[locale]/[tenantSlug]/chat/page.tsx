import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { ChatPanel } from "@/components/chat-panel";
import { routing } from "@/i18n/routing";

export default async function TenantChatPage({ params, searchParams }: {
  params: Promise<{ locale: string; tenantSlug: string }>;
  searchParams: Promise<{ parentOrigin?: string }>;
}): Promise<React.ReactElement> {
  const { locale, tenantSlug } = await params;
  if (!(routing.locales as readonly string[]).includes(locale)) notFound();
  setRequestLocale(locale);
  const parentOrigin = safeOrigin((await searchParams).parentOrigin);
  return <main className="min-h-screen bg-canvas p-3 sm:p-6"><ChatPanel tenantSlug={tenantSlug} locale={locale} bookingHref={`/${tenantSlug}/book`} {...(parentOrigin ? { parentOrigin } : {})} /></main>;
}

function safeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" || url.hostname === "localhost" ? url.origin : undefined; }
  catch { return undefined; }
}
