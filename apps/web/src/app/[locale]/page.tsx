import { getTranslations, setRequestLocale } from "next-intl/server";
import { ApiStatus } from "@/components/api-status";
import { LocaleSwitcher } from "@/components/locale-switcher";

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
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-10 px-6 py-16">
      <header className="flex items-start justify-between gap-6">
        <div>
          <p className="text-sm font-medium text-brand-600">{common("appName")}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{t("title")}</h1>
        </div>
        <LocaleSwitcher label={common("language")} />
      </header>

      <p className="max-w-2xl text-lg leading-relaxed text-slate-600 dark:text-slate-300">
        {t("description")}
      </p>

      <ApiStatus />

      <p className="mt-auto rounded-lg border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        {t("phaseNotice")}
      </p>
    </main>
  );
}
