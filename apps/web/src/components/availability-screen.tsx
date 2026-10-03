"use client";

import { PageLoading } from "./ui/loading";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ApiError,
  apiFetch,
  type AssignedService,
  type Paginated,
  type Provider,
} from "@/lib/api-client";
import { diaryScopeFor } from "@/lib/delegation";
import { AvailabilityExceptions } from "./availability-exceptions";
import { canSeeProviderDelegates, ProviderDelegates } from "./provider-delegates";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { WorkingHoursEditor } from "./working-hours-editor";
import { DashboardShell, useDashboardContext, useSignInRedirect } from "./dashboard-shell";
import { NoOrganizationPanel } from "./no-organization";
import { Alert, AlertDescription, AlertLink } from "./ui/alert";
import { FormField } from "./ui/form-field";
import { NativeSelect } from "./ui/native-select";
import { Section } from "./ui/section";

/**
 * Provider availability. tech-impl §28.
 *
 * ## Who can edit what
 *
 * An administrator opens a provider from the Providers list; a linked provider sees their
 * own; a delegate sees the diaries handed to them
 * (docs/phase-3-4-diary-delegation.md §6.2). Only assistants get the picker, even with one
 * provider, so they can see whose diary they are managing without holding
 * `:all`. That mirrors the API exactly, but it is still only an affordance: the
 * server re-decides on every request, so editing the URL gets a 403 rather than
 * someone else's schedule.
 *
 * ## How an administrator arrives
 *
 * From a provider's row on the Providers screen, which passes `?providerId=`.
 * There is no top-level Availability nav item for them any more: a diary belongs
 * to a provider, and the nav implied it belonged to the organization (§2.7). The
 * parameter selects that diary. Assistants can switch their delegated diaries
 * with the picker; providers remain on their own diary.
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
  const canSelectProvider = context.me?.membership?.role === "ASSISTANT";

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
  const providerId =
    context.me?.membership?.role === "PROVIDER"
      ? scope.ownProviderId
      : inScope
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
    // A 404 here is an answer, not a blip: see `providerArchived` below.
    retry: (failures, error) => !isProviderNotFound(error) && failures < 1,
  });

  // The provider row is gone from this caller's view. For a PROVIDER that can
  // only mean archived: `Membership.providerId` is a same-tenant foreign key
  // with `SetNull`, so a row that no longer existed would have unlinked them
  // and landed on `notLinked` instead. Archiving leaves the link in place, and
  // every availability endpoint 404s on an archived provider — so without this
  // the screen rendered three editors whose every request failed, and the
  // provider was shown a bare "Provider not found" about themselves.
  const providerArchived = isProviderNotFound(provider.error);

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
    return <PageLoading label={t("loading")} />;
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

  const showDelegates = providerId !== null && canSeeProviderDelegates(context, providerId);

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
      ) : providerArchived ? (
        <Section title={t("title")}>
          <Alert variant="warning">
            <AlertDescription>
              {context.me.membership?.role === "PROVIDER"
                ? t("providerArchivedOwn")
                : t("providerArchivedOther")}
            </AlertDescription>
          </Alert>
        </Section>
      ) : (
        <>
          {canSelectProvider && options.length > 0 ? (
            <Section title={t("title")}>
              <FormField id="availability-provider" label={t("provider")}>
                <NativeSelect
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
                </NativeSelect>
              </FormField>
            </Section>
          ) : null}

          {offersNothing ? (
            <Alert variant="warning">
              <AlertDescription>
                {t.rich("providerOffersNothing", {
                  link: (chunks) => <AlertLink href="/dashboard/providers">{chunks}</AlertLink>,
                })}
              </AlertDescription>
            </Alert>
          ) : null}

          {context.tenantId ? (
            // Three independent jobs on one diary, so tabs rather than one long
            // page (phase-11-shadcn-adoption §3.8). Every panel is `forceMount`:
            // Radix would otherwise unmount the working-hours editor on a tab
            // switch and silently discard an unsaved week.
            <Tabs defaultValue="hours">
              <TabsList aria-label={t("title")}>
                <TabsTrigger value="hours">{t("workingHours")}</TabsTrigger>
                <TabsTrigger value="exceptions">{t("exceptions")}</TabsTrigger>
                {showDelegates ? (
                  <TabsTrigger value="delegates">{t("delegates")}</TabsTrigger>
                ) : null}
              </TabsList>
              <TabsContent value="hours" forceMount>
                <WorkingHoursEditor
                  tenantId={context.tenantId}
                  providerId={providerId}
                  timezone={provider.data?.timezone ?? null}
                />
              </TabsContent>
              <TabsContent value="exceptions" forceMount>
                <AvailabilityExceptions
                  tenantId={context.tenantId}
                  providerId={providerId}
                  timezone={provider.data?.timezone ?? null}
                />
              </TabsContent>
              {showDelegates ? (
                <TabsContent value="delegates" forceMount>
                  <ProviderDelegates tenantId={context.tenantId} providerId={providerId} />
                </TabsContent>
              ) : null}
            </Tabs>
          ) : null}
        </>
      )}
    </DashboardShell>
  );
}

function isProviderNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === "PROVIDER_NOT_FOUND";
}
