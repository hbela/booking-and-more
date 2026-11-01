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
      {/* No link to /sign-up: during invite-only launch a self-registered
          account can neither create an organization nor subscribe
          (docs/customer-onboarding-and-website-links.md §2.4). */}
      <p className="text-ink-muted text-sm">
        {t.rich("invitationOnly", {
          pricing: (chunks) => (
            <Link
              href="/pricing"
              className="text-primary hover:text-primary-hover font-medium underline underline-offset-2"
            >
              {chunks}
            </Link>
          ),
        })}
      </p>
    </AuthLayout>
  );
}
