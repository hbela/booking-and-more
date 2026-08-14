"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { apiFetch, type MeResponse } from "@/lib/api-client";
import { AdminShell } from "./admin-shell";
import { ButtonLink } from "./ui/button";
import { Card } from "./ui/card";

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
        <Card title={t("signedOutTitle")}>
          <p className="text-sm text-ink-muted">{t("signedOutHint")}</p>
          <ButtonLink href="/sign-in" >
            {t("signedOutLink")}
          </ButtonLink>
        </Card>
      );
    }

    // Signed in, but this is not their area. Say so and point them at theirs,
    // rather than leaving them on a page with nothing on it.
    if (!me.data.user.isPlatformAdmin) {
      return (
        <Card title={t("notAdminTitle")}>
          <p className="text-sm text-ink-muted">{t("notAdminHint")}</p>
          <ButtonLink href="/dashboard" >
            {t("notAdminLink")}
          </ButtonLink>
        </Card>
      );
    }

    return (
      <Card title={t("platformAdminTitle")}>
        <p className="text-sm text-ink-muted">{t("platformAdminHint")}</p>
        <ButtonLink href="/admin/platform" >
          {t("platformAdminLink")}
        </ButtonLink>
      </Card>
    );
  }
}
