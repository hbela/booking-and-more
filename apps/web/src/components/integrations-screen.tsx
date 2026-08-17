"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ApiError, apiFetch, type Paginated, type Provider } from "@/lib/api-client";
import {
  canRetry,
  healthTone,
  isSuccessOutcome,
  parseCallbackOutcome,
  resolveIntegrationHealth,
  writeCalendarOf,
  type CalendarIntegrationView,
  type IntegrationHealth,
} from "@/lib/integration-state";
import { DashboardShell, useDashboardContext, useSignInRedirect } from "./dashboard-shell";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { Card } from "./ui/card";
import { ErrorText, Field } from "./ui/field";
import { Select } from "./ui/input";
import { Section } from "./ui/section";

interface IntegrationsResponse {
  configured: boolean;
  integrations: CalendarIntegrationView[];
}

interface GoogleCalendar {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
  timeZone: string | null;
  selected: boolean;
}

/**
 * Google Calendar, from the provider's side.
 * docs/phase-6-google-calendar-part-1.md §7.9.
 *
 * Five states, and the screen's job is to show exactly one of them per
 * connection: the platform has no credentials, nobody has connected, connected
 * with no calendar chosen, connected and working, and connected but broken. Which
 * one is decided by `lib/integration-state.ts` rather than here, because the
 * ordering between "needs re-consent" and "sync failed" is the part that is easy
 * to get wrong and impossible to see in JSX.
 *
 * Everything this screen offers is authorised again server-side. Hiding the
 * Connect button from an ASSISTANT is an affordance, never the control.
 */
export function IntegrationsScreen(): React.ReactElement {
  const t = useTranslations("integrations");
  const dashboard = useTranslations("dashboard");
  const context = useDashboardContext();
  useSignInRedirect(!context.isPending && !context.me);

  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);

  const integrations = useQuery({
    queryKey: ["integrations", context.tenantId],
    queryFn: () =>
      apiFetch<IntegrationsResponse>("/v1/integrations/google", { tenantId: context.tenantId }),
    enabled: Boolean(context.tenantId),
  });

  /**
   * The diaries an owner may connect on somebody's behalf.
   *
   * Only fetched for a caller who may read them: a `PROVIDER` holds
   * `integration:manage:own` and not `provider:manage`, and for them the choice
   * has one answer anyway — their own diary, from their membership.
   */
  const canManageProviders = context.can("provider:manage");
  const providers = useQuery({
    queryKey: ["providers", context.tenantId],
    queryFn: () =>
      apiFetch<Paginated<Provider>>("/v1/providers", { tenantId: context.tenantId }),
    enabled: Boolean(context.tenantId) && canManageProviders,
  });

  const ownProviderId = context.me?.membership?.providerId ?? null;
  const [providerId, setProviderId] = useState<string>("");
  const connectFor = ownProviderId ?? (providerId || (providers.data?.items[0]?.id ?? ""));

  const connect = useMutation({
    mutationFn: (provider: string) =>
      apiFetch<{ authorizationUrl: string }>("/v1/integrations/google/connect", {
        method: "POST",
        tenantId: context.tenantId,
        body: { providerId: provider, returnPath: "/dashboard/integrations" },
      }),
    onSuccess: (result) => {
      // A **top-level** navigation, not a popup and not an iframe: Google
      // refuses to render its consent screen in a frame, and popups are blocked
      // often enough to be a support burden. The browser comes back to the
      // `returnPath` recorded above, which is why it is not sent through Google.
      window.location.assign(result.authorizationUrl);
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : dashboard("genericError"));
    },
  });

  const calendars = useQuery({
    queryKey: ["integration-calendars", picking],
    queryFn: () =>
      apiFetch<{ items: GoogleCalendar[] }>(`/v1/integrations/google/${picking!}/calendars`, {
        tenantId: context.tenantId,
      }),
    enabled: picking !== null,
  });

  const select = useMutation({
    mutationFn: (args: { integrationId: string; externalCalendarId: string; name: string }) =>
      apiFetch<{ backfilled: number; replacedCalendarId: string | null }>(
        `/v1/integrations/google/${args.integrationId}/calendars/select`,
        {
          method: "POST",
          tenantId: context.tenantId,
          body: { externalCalendarId: args.externalCalendarId, calendarName: args.name },
        },
      ),
    onSuccess: () => {
      setPicking(null);
      void queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : dashboard("genericError"));
    },
  });

  const retry = useMutation({
    mutationFn: (integrationId: string) =>
      apiFetch<{ requeued: number }>(`/v1/integrations/google/${integrationId}/sync`, {
        method: "POST",
        tenantId: context.tenantId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : dashboard("genericError"));
    },
  });

  const disconnect = useMutation({
    mutationFn: (integrationId: string) =>
      apiFetch(`/v1/integrations/google/${integrationId}`, {
        method: "DELETE",
        tenantId: context.tenantId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : dashboard("genericError"));
    },
  });

  if (context.isPending || !context.me) {
    return <p className="p-8">{dashboard("loading")}</p>;
  }

  const configured = integrations.data?.configured ?? false;
  const rows = integrations.data?.integrations ?? [];
  const mayConnect = ownProviderId !== null || canManageProviders;

  return (
    <DashboardShell context={context}>
      <Card title={t("title")}>
        <p className="text-sm text-ink-muted">{t("intro")}</p>

        {/* Suspended, and it has to be: `useSearchParams` opts a component out
            of prerendering, and without a boundary the whole screen goes with
            it — which `next build` refuses rather than doing quietly. The
            fallback is `null` because there is genuinely nothing to say until
            the URL is known. Caught by the build, not by lint or tsc. */}
        <Suspense fallback={null}>
          <CallbackNotice />
        </Suspense>

        <ErrorText>{error}</ErrorText>

        {/* Rule 4, on screen. "The platform has not set this up" and "nobody has
            connected yet" are the same empty list and need opposite words —
            which is exactly why the API reports `configured` rather than letting
            it be inferred. */}
        {!configured ? (
          <Callout tone="info">{t("notConfigured")}</Callout>
        ) : rows.length === 0 ? (
          <Callout tone="info">{t("noneConnected")}</Callout>
        ) : null}

        {configured && mayConnect ? (
          <div className="flex flex-wrap items-end gap-3">
            {/* An owner picks whose diary; a provider has only their own and is
                not asked. */}
            {ownProviderId === null && canManageProviders ? (
              <Field id="integration-provider" label={t("connectFor")}>
                <Select
                  id="integration-provider"
                  value={connectFor}
                  onChange={(event) => {
                    setProviderId(event.target.value);
                  }}
                >
                  {(providers.data?.items ?? []).map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.displayName}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            <Button
              disabled={connect.isPending || connectFor === ""}
              onClick={() => {
                setError(null);
                connect.mutate(connectFor);
              }}
            >
              {connect.isPending ? dashboard("loading") : t("connect")}
            </Button>
          </div>
        ) : null}

        {configured && !mayConnect ? (
          <p className="text-sm text-ink-subtle">{t("noDiaryToConnect")}</p>
        ) : null}
      </Card>

      {rows.map((integration) => {
        const health = resolveIntegrationHealth(integration);
        const chosen = writeCalendarOf(integration);

        return (
          <Card key={integration.id} title={integration.accountEmail}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={healthTone(health)}>{t(`health.${health.kind}`)}</Badge>
              {integration.providerName ? (
                <span className="text-sm text-ink-muted">
                  {t("forProvider", { provider: integration.providerName })}
                </span>
              ) : null}
            </div>

            <HealthDetail health={health} />

            {chosen ? (
              <p className="text-sm text-ink-muted">
                {t("writingTo", {
                  calendar: chosen.calendarName ?? chosen.externalCalendarId,
                })}
              </p>
            ) : null}

            {/* The calendar picker, opened on demand: it calls Google live, so
                it is not something to do on every page load. */}
            {picking === integration.id ? (
              <Section title={t("chooseCalendar")}>
                {calendars.isPending ? (
                  <p className="text-sm text-ink-muted">{dashboard("loading")}</p>
                ) : calendars.isError ? (
                  <ErrorText>{t("calendarsUnavailable")}</ErrorText>
                ) : (
                  <>
                    {/* Said before the choice, not after it: re-pointing leaves
                        the events already written where they are, and that is
                        not something to discover afterwards (known limit 6). */}
                    {chosen ? <Callout tone="action">{t("repointWarning")}</Callout> : null}

                    <ul className="flex flex-col gap-2">
                      {(calendars.data?.items ?? []).map((calendar) => (
                        <li key={calendar.id} className="flex flex-wrap items-center gap-2">
                          <Button
                            variant={calendar.selected ? "secondary" : "primary"}
                            size="sm"
                            disabled={select.isPending}
                            onClick={() => {
                              setError(null);
                              select.mutate({
                                integrationId: integration.id,
                                externalCalendarId: calendar.id,
                                name: calendar.summary,
                              });
                            }}
                          >
                            {calendar.summary}
                          </Button>
                          {calendar.primary ? (
                            <Badge tone="neutral">{t("primaryCalendar")}</Badge>
                          ) : null}
                          {calendar.selected ? <Badge tone="success">{t("current")}</Badge> : null}
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPicking(null);
                  }}
                >
                  {t("cancel")}
                </Button>
              </Section>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {integration.status === "ACTIVE" && picking !== integration.id ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setError(null);
                    setPicking(integration.id);
                  }}
                >
                  {chosen ? t("changeCalendar") : t("chooseCalendar")}
                </Button>
              ) : null}

              {/* §25.6's Retry. Absent rather than disabled when it could not
                  work — see `canRetry`. */}
              {canRetry(health) ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={retry.isPending}
                  onClick={() => {
                    setError(null);
                    retry.mutate(integration.id);
                  }}
                >
                  {retry.isPending ? dashboard("loading") : t("retry")}
                </Button>
              ) : null}

              {integration.status !== "DISCONNECTED" ? (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={disconnect.isPending}
                  onClick={() => {
                    setError(null);
                    // The dialog says what disconnecting does *not* do, because
                    // the events staying in Google is the surprising half —
                    // they are real appointments somebody still has to attend.
                    if (window.confirm(t("disconnectConfirm"))) {
                      disconnect.mutate(integration.id);
                    }
                  }}
                >
                  {t("disconnect")}
                </Button>
              ) : null}
            </div>
          </Card>
        );
      })}
    </DashboardShell>
  );
}

/**
 * What the OAuth callback left in the URL on its way back.
 *
 * Its own component so that reading the query string suspends *this* and not the
 * screen around it. The value is narrowed to a known key before anything renders
 * — `parseCallbackOutcome` never passes the raw parameter through, because a
 * message keyed off it would put arbitrary attacker-typed text on a signed-in
 * page.
 *
 * `role="status"` on success and `alert` on failure: the first confirms
 * something the user asked for, the second interrupts.
 */
function CallbackNotice(): React.ReactElement | null {
  const t = useTranslations("integrations");
  const outcome = parseCallbackOutcome(useSearchParams().get("calendar"));

  if (outcome === null) return null;

  const succeeded = isSuccessOutcome(outcome);

  return (
    <Callout tone={succeeded ? "success" : "danger"} role={succeeded ? "status" : "alert"}>
      {t(`outcome.${outcome}`)}
    </Callout>
  );
}

/**
 * The sentence under the chip.
 *
 * Split out so the badge and its explanation cannot drift apart: both are driven
 * by the same `health.kind`, and a `switch` here makes a missing case a type
 * error rather than a blank space on the screen.
 */
function HealthDetail({ health }: { health: IntegrationHealth }): React.ReactElement | null {
  const t = useTranslations("integrations");

  switch (health.kind) {
    case "needsReconnect":
      return (
        <Callout tone="danger" role="note">
          {t("needsReconnectDetail")}
        </Callout>
      );
    case "noCalendar":
      return <Callout tone="action">{t("noCalendarDetail")}</Callout>;
    case "failed":
      // tech-impl §25.6, and its second line matters as much as the first: the
      // sync failed *and* a retry is already scheduled, so nobody has to do
      // anything for it to be attempted again.
      return <Callout tone="danger">{t("failedDetail", { count: health.failed })}</Callout>;
    case "syncing":
      return <p className="text-sm text-ink-muted">{t("syncingDetail", { count: health.queued })}</p>;
    case "healthy":
      return <p className="text-sm text-ink-muted">{t("healthyDetail", { count: health.synced })}</p>;
    case "disconnected":
      return <p className="text-sm text-ink-muted">{t("disconnectedDetail")}</p>;
  }
}
