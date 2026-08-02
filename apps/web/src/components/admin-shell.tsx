"use client";

import { useTranslations } from "next-intl";
import { AuthHeader } from "./auth-header";

/**
 * The frame every `/admin/*` screen sits in.
 *
 * Deliberately thinner than {@link DashboardShell}: there is no tenant here, so
 * no switcher and no section nav. What it does give the platform screens is the
 * thing they had none of — a header, a locale switch and a way to sign out.
 *
 * Signing out returns to `/admin` rather than `/sign-in`, so an operator who
 * signs out lands somewhere that explains itself and offers the way back in.
 */
export function AdminShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const t = useTranslations("admin");

  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <AuthHeader signOutTo="/admin" />
      </header>

      {children}
    </div>
  );
}
