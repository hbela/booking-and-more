import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthForm } from "@/components/auth-form";
import { AuthLayout } from "@/components/ui/auth-layout";
import { Link } from "@/i18n/navigation";

export default async function SignInPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("auth");

  return (
    <AuthLayout title={t("signInTitle")}>
      <AuthForm mode="sign-in" />
      <p className="text-ink-muted text-sm">
        {t("noAccount")}{" "}
        <Link
          href="/sign-up"
          className="text-primary hover:text-primary-hover font-medium underline underline-offset-2"
        >
          {t("createAccount")}
        </Link>
      </p>
    </AuthLayout>
  );
}
