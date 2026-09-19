import Image from "next/image";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthHeader } from "@/components/auth-header";
import { Brand } from "@/components/brand";
import { InstallApp } from "@/components/staff-pwa";
import { ButtonLink } from "@/components/ui/button";
import { CalendarDays, Smartphone, Users } from "lucide-react";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations("home");
  const pwa = await getTranslations("pwa");

  return (
    <main className="flex min-h-screen flex-col">
      {/* The header sits on the page surface rather than over the hero: the
          controls inside it (a native select, a button, a link) are themed, and
          floating them on dark artwork would mean a second colour scheme for
          every one of them. */}
      <div className="border-line border-b">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-end justify-between gap-6 px-6 py-4">
          <Brand />
          {/* The way in — this is where an operator starts before /admin. */}
          <AuthHeader signOutTo="/" />
        </div>
      </div>

      {/* One image for both themes, deliberately: a browser can match
          `prefers-color-scheme` but not our `data-theme` cookie, so a per-theme
          <picture> would hand the dark art to somebody who chose light on a
          dark laptop (phase-11 §5.3). The artwork is dark and the scrim over it
          is fixed, so the light text on top holds its contrast either way. */}
      <header className="relative isolate overflow-hidden">
        <Image
          src="/hero-booking.jpg"
          alt=""
          width={1376}
          height={768}
          priority
          sizes="100vw"
          className="absolute inset-0 -z-10 h-full w-full object-cover"
        />
        <div className="absolute inset-0 -z-10 bg-slate-950/65" />

        <div className="mx-auto w-full max-w-5xl px-6 py-20">
          <h1 className="font-display max-w-3xl text-4xl font-bold tracking-tight text-white sm:text-5xl">
            {t("title")}
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-white/85">{t("description")}</p>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-4 py-12 sm:px-6">
        <div className="grid gap-6 md:grid-cols-2">
          <section
            aria-labelledby="staff-start"
            className="flex flex-col gap-4 rounded-xl border border-line p-6"
          >
            <Users size={28} className="text-primary" aria-hidden="true" />
            <h2 id="staff-start" className="font-display text-2xl font-bold">
              {t("staffTitle")}
            </h2>
            <p className="leading-relaxed text-ink-muted">{t("staffDescription")}</p>
            <ol className="list-decimal space-y-3 pl-5 leading-relaxed">
              <li>{t("staffAccount")}</li>
              <li>{t("staffInstall")}</li>
              <li>{t("staffLaunch")}</li>
            </ol>
            <div className="mt-auto flex flex-wrap gap-3 pt-4">
              <ButtonLink href="/dashboard">{t("staffOpen")}</ButtonLink>
              <ButtonLink href="/sign-up" variant="secondary">
                {t("ownerStart")}
              </ButtonLink>
            </div>
          </section>
          <section
            aria-labelledby="patient-start"
            className="flex flex-col gap-4 rounded-xl border border-line p-6"
          >
            <CalendarDays size={28} className="text-primary" aria-hidden="true" />
            <h2 id="patient-start" className="font-display text-2xl font-bold">
              {t("patientTitle")}
            </h2>
            <p className="leading-relaxed text-ink-muted">{t("patientDescription")}</p>
            <ol className="list-decimal space-y-3 pl-5 leading-relaxed">
              <li>{t("patientLink")}</li>
              <li>{t("patientBook")}</li>
              <li>{t("patientManage")}</li>
            </ol>
            <p className="mt-auto rounded-lg bg-surface-raised p-4 text-sm leading-relaxed text-ink-muted">
              {t("patientInstallNote")}
            </p>
          </section>
        </div>
        <section
          id="install"
          aria-labelledby="install-title"
          className="flex flex-col gap-6 rounded-xl border border-line bg-surface-raised p-6 sm:p-8"
        >
          <Smartphone size={28} className="text-primary" aria-hidden="true" />
          <div>
            <h2 id="install-title" className="font-display text-2xl font-bold">
              {t("installTitle")}
            </h2>
            <p className="mt-3 leading-relaxed text-ink-muted">{t("installDescription")}</p>
          </div>
          <InstallApp />
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <h3 className="font-semibold">Android · Chrome</h3>
              <p className="mt-2 leading-relaxed text-ink-muted">{pwa("androidHelp")}</p>
            </div>
            <div>
              <h3 className="font-semibold">iPhone / iPad · Safari</h3>
              <p className="mt-2 leading-relaxed text-ink-muted">{pwa("iosHelp")}</p>
            </div>
          </div>
          <p className="text-sm leading-relaxed text-ink-muted">{t("onlineNote")}</p>
        </section>
      </div>
    </main>
  );
}
