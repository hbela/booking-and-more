"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { apiFetch, type MeResponse } from "@/lib/api-client";
import { AdminShell } from "./admin-shell";
import { Button } from "./ui/button";
import { Link } from "@/i18n/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

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
        <Card>
          <CardHeader>
            <CardTitle>{t("signedOutTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-ink-muted">{t("signedOutHint")}</p>
            <Button asChild>
              <Link href="/sign-in">{t("signedOutLink")}</Link>
            </Button>
          </CardContent>
        </Card>
      );
    }

    // Signed in, but this is not their area. Say so and point them at theirs,
    // rather than leaving them on a page with nothing on it.
    if (!me.data.user.isPlatformAdmin) {
      return (
        <Card>
          <CardHeader>
            <CardTitle>{t("notAdminTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-ink-muted">{t("notAdminHint")}</p>
            <Button asChild>
              <Link href="/dashboard">{t("notAdminLink")}</Link>
            </Button>
          </CardContent>
        </Card>
      );
    }

    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("platformAdminTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-muted">{t("platformAdminHint")}</p>
          <Button asChild>
            <Link href="/admin/platform">{t("platformAdminLink")}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }
}
