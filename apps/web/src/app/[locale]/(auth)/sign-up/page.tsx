import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthForm } from "@/components/auth-form";
import { AuthLayout } from "@/components/ui/auth-layout";
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
    <AuthLayout title={t("signUpTitle")}>
      <AuthForm mode="sign-up" />
      <p className="text-ink-muted text-sm">
        {t("haveAccount")}{" "}
        <Link
          href="/sign-in"
          className="text-primary hover:text-primary-hover font-medium underline underline-offset-2"
        >
          {t("signIn")}
        </Link>
      </p>
    </AuthLayout>
  );
}
