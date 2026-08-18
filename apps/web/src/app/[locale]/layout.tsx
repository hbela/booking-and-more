import type { Metadata, Viewport } from "next";
import { Inter, Manrope } from "next/font/google";
import { notFound } from "next/navigation";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { QueryProvider } from "@/lib/query-provider";
import { ThemeScript } from "@/components/theme-script";
import "../globals.css";

/**
 * `latin-ext` is not optional. Hungarian ő (U+0151) and ű (U+0171) live in that
 * subset, and Hungarian is the default locale — without it those two characters
 * alone fall back to a different face, mid-word (phase-11 §2.3).
 *
 * Manrope carries headlines, Inter everything else. Both expose a CSS variable
 * that `globals.css` reads through `--font-sans` / `--font-display`.
 */
const inter = Inter({
  subsets: ["latin", "latin-ext"],
  variable: "--font-inter",
  display: "swap",
});

const manrope = Manrope({
  subsets: ["latin", "latin-ext"],
  variable: "--font-manrope",
  display: "swap",
});

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

/**
 * Browser chrome tracks the page ground, so the address bar does not sit as a
 * white band above a dark page.
 *
 * A known limit, recorded rather than rediscovered: `themeColor` can only key
 * on `prefers-color-scheme`. There is no media feature for "this site's cookie",
 * so a visitor who forces light on a dark operating system gets dark browser
 * chrome above a light page. Not fixable from here (phase-11 §5.1).
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1420" },
  ],
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
    // `suppressHydrationWarning` on <html> is for the theme script below, which
    // writes `data-theme` before React hydrates — the server rendered no such
    // attribute, so React would report a mismatch on every themed page load.
    <html lang={locale} className={`${inter.variable} ${manrope.variable}`} suppressHydrationWarning>
      {/* Renders nothing. It emits the theme script into <head> while the
          response streams — synchronous and never deferred, so it runs before
          the browser paints and the visitor never sees a flash of the system
          theme. See components/theme-script.tsx for why it is emitted rather
          than rendered, and lib/theme-script.ts for why it is not read
          server-side. */}
      <ThemeScript />
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
