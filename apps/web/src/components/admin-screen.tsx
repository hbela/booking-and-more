"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { apiFetch, type MeResponse } from "@/lib/api-client";
import { AdminShell } from "./admin-shell";
import { Panel, buttonClass } from "./dashboard-shell";

/**
 * The admin section's landing page, and the one screen that has to make sense
 * to somebody who is *not* signed in — signing out lands here.
 *
 * Which is why this deliberately does not call `useSignInRedirect`. Every other
 * authenticated screen bounces a signed-out visitor to `/sign-in`; doing that
 * here would make signing out an infinite round trip through the sign-in form,
 * and there would be no page left that says "you are signed out" at all.
 */
export function AdminScreen(): React.ReactElement {
  const t = useTranslations("admin");

  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<MeResponse>("/v1/me"),
    retry: false,
  });

  return <AdminShell>{body()}</AdminShell>;

  function body(): React.ReactElement {
    if (me.isPending) return <p>{t("loading")}</p>;

    // No session. A 401 is the ordinary answer here rather than an error.
    if (!me.data) {
      return (
        <Panel title={t("signedOutTitle")}>
          <p className="text-sm text-slate-600 dark:text-slate-400">{t("signedOutHint")}</p>
          <Link href="/sign-in" className={buttonClass}>
            {t("signedOutLink")}
          </Link>
        </Panel>
      );
    }

    // Signed in, but this is not their area. Say so and point them at theirs,
    // rather than leaving them on a page with nothing on it.
    if (!me.data.user.isPlatformAdmin) {
      return (
        <Panel title={t("notAdminTitle")}>
          <p className="text-sm text-slate-600 dark:text-slate-400">{t("notAdminHint")}</p>
          <Link href="/dashboard" className={buttonClass}>
            {t("notAdminLink")}
          </Link>
        </Panel>
      );
    }

    return (
      <Panel title={t("platformAdminTitle")}>
        <p className="text-sm text-slate-600 dark:text-slate-400">{t("platformAdminHint")}</p>
        <Link href="/admin/platform" className={buttonClass}>
          {t("platformAdminLink")}
        </Link>
      </Panel>
    );
  }
}
