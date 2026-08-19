"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { apiFetch, type AssignedService, type Paginated, type Provider } from "@/lib/api-client";
import { diaryScopeFor } from "@/lib/delegation";
import { AvailabilityExceptions } from "./availability-exceptions";
import { ProviderDelegates } from "./provider-delegates";
import { WorkingHoursEditor } from "./working-hours-editor";
import { DashboardShell, useDashboardContext, useSignInRedirect } from "./dashboard-shell";
import { NoOrganizationPanel } from "./no-organization";
import { Callout, CalloutLink } from "./ui/callout";
import { Field } from "./ui/field";
import { Select } from "./ui/input";
import { Section } from "./ui/section";

/**
 * Provider availability. tech-impl §28.
 *
 * ## Who can edit what
 *
 * An administrator picks any provider; a provider linked to a diary sees their
 * own; a delegate sees the diaries handed to them
 * (docs/phase-3-4-diary-delegation.md §6.2). The picker appears when there is
 * more than one to choose between, which is now possible without holding
 * `:all`. That mirrors the API exactly, but it is still only an affordance: the
 * server re-decides on every request, so editing the URL gets a 403 rather than
 * someone else's schedule.
 *
 * ## How an administrator arrives
 *
 * From a provider's row on the Providers screen, which passes `?providerId=`.
 * There is no top-level Availability nav item for them any more: a diary belongs
 * to a provider, and the nav implied it belonged to the organization (§2.7). The
 * parameter only seeds the picker — it is an opening position, not a lock, so
 * the picker still switches between diaries without a navigation.
 *
 * ## Why the provider record is fetched separately
 *
 * Both panels below need `provider.timezone`. The list query is gated on
 * `canManageAll`, so on the `:own` path there is no list to read it from — and
 * that is precisely the path where a wrong zone matters most, because a provider
 * editing their own diary is the person whose closures have to land where they
 * meant.
 */
export function AvailabilityScreen(): React.ReactElement {
  const t = useTranslations("availability");
  const context = useDashboardContext();
  useSignInRedirect(!context.isPending && !context.me);

  const scope = diaryScopeFor(context.me, "availability:manage:all", "AVAILABILITY");
  const canManageAll = scope.everyDiary;

  // Seeded from the URL, then owned by the picker. `useState`'s initialiser
  // rather than an effect: an effect would paint the first provider's diary
  // before correcting itself, and that flash is somebody else's schedule.
  const fromUrl = useSearchParams().get("providerId");
  const [selected, setSelected] = useState<string | null>(fromUrl);

  // Fetched for a delegate too, not only an administrator: an ASSISTANT holds
  // `tenant:read`, so the list resolves, and without names the picker would
  // offer opaque ids. The options are filtered to `scope` below — the list is
  // for labels, never for reach.
  const providers = useQuery({
    queryKey: ["providers", context.tenantId],
    queryFn: () =>
      apiFetch<Paginated<Provider>>("/v1/providers?limit=100", { tenantId: context.tenantId }),
    enabled: Boolean(context.tenantId) && (canManageAll || scope.providerIds.length > 0),
  });

  const options = (providers.data?.items ?? []).filter(
    (entry) => canManageAll || scope.providerIds.includes(entry.id),
  );

  // The selection has to be *in* scope: `?providerId=` is a seed from a link,
  // not an authorisation, and honouring one outside the scope would render a
  // screen whose every request 403s.
  const inScope = selected !== null && options.some((entry) => entry.id === selected);
  const providerId = inScope
    ? selected
    : (options[0]?.id ??
      // Before the list resolves, a member with exactly one diary already knows
      // which it is. Avoids a blank frame on the commonest path of all.
      (scope.providerIds.length === 1 ? scope.providerIds[0]! : null));

  const provider = useQuery({
    queryKey: ["provider", providerId],
    queryFn: () =>
      apiFetch<Provider>(`/v1/providers/${providerId!}`, { tenantId: context.tenantId }),
    enabled: Boolean(context.tenantId) && providerId !== null,
  });

  // Working hours on a provider who offers nothing produce no bookable slots,
  // and the screen would otherwise look complete. This is the last place the
  // owner passes through before expecting bookings, so it is the right place to
  // say so.
  const assigned = useQuery({
    queryKey: ["provider-services", providerId],
    queryFn: () =>
      apiFetch<{ items: AssignedService[] }>(`/v1/providers/${providerId!}/services`, {
        tenantId: context.tenantId,
      }),
    enabled: Boolean(context.tenantId) && providerId !== null,
  });

  const offersNothing = assigned.isSuccess && assigned.data.items.length === 0;

  if (context.isPending || !context.me) {
    return <p className="p-8">{t("loading")}</p>;
  }

  // Signed in, but there is no organization to scope this screen to. Every
  // query below is gated on `context.tenantId`, so without this the shell
  // renders around a body that never fills (see no-organization.tsx).
  if (context.hasNoOrganization) {
    return (
      <DashboardShell context={context}>
        <NoOrganizationPanel isPlatformAdmin={context.me.user.isPlatformAdmin} />
      </DashboardShell>
    );
  }

  return (
    <DashboardShell context={context}>
      {providerId === null ? (
        <Section title={t("title")}>
          <p className="text-sm text-ink-muted">
            {canManageAll
              ? t("noProviders")
              : scope.ownProviderId === null
                ? // Distinct from "not linked to a diary": a front-desk member
                  // is not supposed to have one, and telling them to ask for a
                  // diary would send them after the wrong thing (§6.2).
                  t("notDelegated")
                : t("notLinked")}
          </p>
        </Section>
      ) : (
        <>
          {options.length > 1 ? (
            <Section title={t("title")}>
              <Field id="availability-provider" label={t("provider")}>
                <Select
                  id="availability-provider"
                  value={providerId}
                  onChange={(event) => {
                    setSelected(event.target.value);
                  }}
                  className="max-w-sm"
                >
                  {options.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.displayName}
                    </option>
                  ))}
                </Select>
              </Field>
            </Section>
          ) : null}

          {offersNothing ? (
            <Callout tone="action">
              {t.rich("providerOffersNothing", {
                link: (chunks) => <CalloutLink href="/dashboard/providers">{chunks}</CalloutLink>,
              })}
            </Callout>
          ) : null}

          {context.tenantId ? (
            <>
              <WorkingHoursEditor
                tenantId={context.tenantId}
                providerId={providerId}
                timezone={provider.data?.timezone ?? null}
              />
              <AvailabilityExceptions
                tenantId={context.tenantId}
                providerId={providerId}
                timezone={provider.data?.timezone ?? null}
              />
              <ProviderDelegates tenantId={context.tenantId} providerId={providerId} />
            </>
          ) : null}
        </>
      )}
    </DashboardShell>
  );
}
