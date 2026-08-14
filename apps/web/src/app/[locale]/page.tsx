import Image from "next/image";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ApiStatus } from "@/components/api-status";
import { AuthHeader } from "@/components/auth-header";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations("home");
  const common = await getTranslations("common");

  return (
    <main className="flex min-h-screen flex-col">
      {/* The header sits on the page surface rather than over the hero: the
          controls inside it (a native select, a button, a link) are themed, and
          floating them on dark artwork would mean a second colour scheme for
          every one of them. */}
      <div className="border-line border-b">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-end justify-between gap-6 px-6 py-4">
          <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase">
            {common("appName")}
          </p>
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

      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-12">
        <ApiStatus />

        <p className="border-line text-ink-muted mt-auto rounded-xl border border-dashed px-4 py-3 text-sm">
          {t("phaseNotice")}
        </p>
      </div>
    </main>
  );
}
