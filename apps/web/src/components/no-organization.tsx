"use client";

import { useTranslations } from "next-intl";
import { ButtonLink } from "./ui/button";
import { Card } from "./ui/card";

/**
 * What a signed-in user sees on a tenant screen when there is no tenant.
 *
 * Every screen under `dashboard/` is scoped to one organization, and each one
 * gates its queries on `context.tenantId`. When that is undefined the queries
 * never fire, so the screen used to render its shell around a body that stayed
 * empty for ever — indistinguishable from a hung request, and reported as one.
 * The overview alone handled the state; the six other screens did not.
 *
 * Two audiences, and they need opposite things:
 *
 * - **A platform admin** holds no memberships *by design* (CLAUDE.md rule 9),
 *   so this is not a transient state they can fix — it is permanent for that
 *   account, and `canHoldTenantMembership` refuses to let them join a tenant to
 *   escape it. Offering them "create an organization" would be offering an
 *   action the API exists to refuse, so they are pointed at the platform
 *   dashboard, which is the screen that is actually theirs. The copy is shared
 *   with the overview's own panel rather than written twice.
 *
 * - **Anybody else** with no organization is in a real but recoverable state —
 *   a fresh account, or a membership that was removed. They are sent to the
 *   overview rather than shown a create form here, because the form belongs in
 *   exactly one place and duplicating it would make two screens able to create
 *   an organization while only one of them stayed in step with what that takes.
 */
export function NoOrganizationPanel({
  isPlatformAdmin,
}: {
  isPlatformAdmin: boolean;
}): React.ReactElement {
  const admin = useTranslations("admin");
  const t = useTranslations("dashboard");

  if (isPlatformAdmin) {
    return (
      <Card title={admin("platformAdminTitle")}>
        <p className="text-sm text-ink-muted">{admin("platformAdminHint")}</p>
        <ButtonLink href="/admin">{admin("platformAdminLink")}</ButtonLink>
      </Card>
    );
  }

  return (
    <Card title={t("noOrganizationTitle")}>
      <p className="text-sm text-ink-muted">{t("noOrganizationHint")}</p>
      <ButtonLink href="/dashboard">{t("noOrganizationLink")}</ButtonLink>
    </Card>
  );
}
