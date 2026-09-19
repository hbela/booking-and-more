"use client";

import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { tenantQrTarget } from "@/lib/tenant-pwa";
import { Section } from "./ui/section";
import { buttonRecipe } from "./ui/button";

export function PatientQrCodes({ slug, assistant }: { slug: string; assistant: boolean }) {
  const t = useTranslations("patientQr");
  const locale = useLocale() === "en" ? "en" : "hu";
  const destinations = assistant ? (["book", "chat"] as const) : (["book"] as const);
  return (
    <Section title={t("title")} description={t("description")} variant="card">
      <div className="grid gap-6 sm:grid-cols-2">
        {destinations.map((destination) => {
          const qr = `/api/pwa/${slug}/${destination}/qr?locale=${locale}`;
          return (
            <div key={destination} className="flex flex-col items-start gap-3">
              <h3 className="font-semibold">{t(destination)}</h3>
              <a href={tenantQrTarget(slug, destination, locale)} aria-label={t(destination)}>
                <Image
                  src={qr}
                  alt={t("image", { destination: t(destination) })}
                  width={256}
                  height={256}
                  unoptimized
                  className="h-auto max-w-full"
                />
              </a>
              <a
                href={qr}
                download={`${slug}-${destination}-${locale}.svg`}
                className={buttonRecipe({ variant: "secondary" })}
              >
                {t("download", { destination: t(destination) })}
              </a>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
