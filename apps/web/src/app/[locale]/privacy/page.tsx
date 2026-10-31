import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { LegalDocumentView } from "@/components/legal-document";
import { PublicFooter, PublicHeader } from "@/components/public-page";
import { legalDocument } from "@/content/legal";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return { title: legalDocument("privacy", locale).title };
}

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <main className="flex min-h-screen flex-col">
      <PublicHeader />
      <LegalDocumentView document={legalDocument("privacy", locale)} locale={locale} />
      <PublicFooter />
    </main>
  );
}
