import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { QueryProvider } from "@/lib/query-provider";
import "../globals.css";

export function generateStaticParams(): { locale: string }[] {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "common" });

  return {
    title: t("appName"),
    description: t("tagline"),
    manifest: "/manifest.webmanifest",
    applicationName: t("appName"),
  };
}

export const viewport: Viewport = {
  themeColor: "#0f766e",
  width: "device-width",
  initialScale: 1,
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  // Required for static rendering of this locale's routes.
  setRequestLocale(locale);

  return (
    <html lang={locale}>
      {/* Browser extensions — Grammarly is the common one — add attributes to
          <body> before React hydrates (`data-gr-ext-installed`,
          `data-new-gr-c-s-check-loaded`), which React reports as a mismatch
          nobody can fix from here. This suppresses one element's attributes and
          text, not its subtree, so a genuine mismatch inside the app is still
          reported. */}
      <body suppressHydrationWarning>
        <NextIntlClientProvider>
          <QueryProvider>{children}</QueryProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
