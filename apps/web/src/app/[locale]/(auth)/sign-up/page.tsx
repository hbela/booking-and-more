import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthForm } from "@/components/auth-form";
import { Link } from "@/i18n/navigation";

export default async function SignUpPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("auth");

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <h1 className="text-2xl font-semibold">{t("signUpTitle")}</h1>
      <AuthForm mode="sign-up" />
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {t("haveAccount")}{" "}
        <Link href="/sign-in" className="text-brand-600 underline">
          {t("signIn")}
        </Link>
      </p>
    </main>
  );
}
