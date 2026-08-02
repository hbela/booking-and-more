"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ApiError, apiFetch, type MeResponse } from "@/lib/api-client";
import {
  ErrorText,
  Field,
  Panel,
  Section,
  buttonClass,
  inputClass,
  useSignInRedirect,
} from "./dashboard-shell";

/**
 * Platform administration. docs/phase-9-saas-administration.md §7.
 *
 * Ported from `booking-for-all`'s `routes/admin/` — the shape of the screen is
 * the good part of that implementation and worth keeping. What is not kept:
 * shadcn/radix and TanStack Table (this app has neither, and a table of a dozen
 * organizations does not need a virtualiser), and the temporary password shown
 * on creation. Provisioning here returns a single-use acceptance link instead.
 */

interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  status: "PENDING_SUBSCRIPTION" | "TRIAL" | "ACTIVE" | "SUSPENDED" | "CLOSED";
  subscribeBy: string | null;
  daysRemaining: number | null;
  createdAt: string;
  owner: { email: string; name: string | null; accepted: boolean } | null;
  subscription: {
    plan: "INTERNAL" | "STARTER" | "PROFESSIONAL";
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
}

interface ProvisionResponse {
  organization: OrganizationSummary;
  acceptUrl: string;
}

function textField(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function PlatformScreen(): React.ReactElement {
  const t = useTranslations("platform");
  const queryClient = useQueryClient();

  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<MeResponse>("/v1/me"),
    retry: false,
  });

  useSignInRedirect(!me.isPending && !me.data);

  const [search, setSearch] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  /**
   * Shown once, after provisioning. Held in state rather than refetched because
   * the server does not store it — only its hash (tech-impl §34.4). Navigating
   * away loses it, which is why the resend action exists.
   */
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);

  const organizations = useQuery({
    queryKey: ["platform", "organizations", search],
    queryFn: () =>
      apiFetch<{ items: OrganizationSummary[] }>(
        `/v1/platform/organizations${search ? `?search=${encodeURIComponent(search)}` : ""}`,
      ),
    enabled: me.data?.user.isPlatformAdmin === true,
  });

  const provision = useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiFetch<ProvisionResponse>("/v1/platform/organizations", { method: "POST", body }),
    onSuccess: (result) => {
      setFormError(null);
      setAcceptUrl(result.acceptUrl);
      void queryClient.invalidateQueries({ queryKey: ["platform", "organizations"] });
    },
    onError: (error: unknown) => {
      setFormError(error instanceof ApiError ? error.message : t("provisionFailed"));
    },
  });

  const setStatus = useMutation({
    mutationFn: (input: { id: string; status: "ACTIVE" | "SUSPENDED" }) =>
      apiFetch<OrganizationSummary>(`/v1/platform/organizations/${input.id}/status`, {
        method: "PATCH",
        body: { status: input.status },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["platform", "organizations"] });
    },
  });

  const resend = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ acceptUrl: string }>(`/v1/platform/organizations/${id}/resend-invitation`, {
        method: "POST",
      }),
    onSuccess: (result) => {
      setAcceptUrl(result.acceptUrl);
    },
  });

  if (me.isPending) return <p className="p-8">{t("loading")}</p>;

  // Redirected from an effect, so render something harmless meanwhile.
  if (!me.data) return <p className="p-8">{t("loading")}</p>;

  // The API refuses these routes regardless; this only avoids showing a screen
  // whose every request would 403.
  if (!me.data.user.isPlatformAdmin) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-8">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <ErrorText>{t("notPlatformAdmin")}</ErrorText>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">{t("subtitle")}</p>
      </header>

      {acceptUrl === null ? null : (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm dark:border-emerald-800 dark:bg-emerald-950"
        >
          <strong>{t("acceptLinkHeading")}</strong>
          <p className="text-slate-700 dark:text-slate-300">{t("acceptLinkExplanation")}</p>
          <code className="overflow-x-auto rounded bg-white/70 p-2 font-mono text-xs dark:bg-black/30">
            {acceptUrl}
          </code>
          <button
            type="button"
            className="self-start text-xs underline"
            onClick={() => {
              setAcceptUrl(null);
            }}
          >
            {t("dismiss")}
          </button>
        </div>
      )}

      <Panel title={t("provisionHeading")}>
        <p className="text-sm text-slate-600 dark:text-slate-400">{t("provisionExplanation")}</p>

        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);

            provision.mutate({
              name: textField(data, "name"),
              slug: textField(data, "slug"),
              domain: textField(data, "domain"),
              ownerName: textField(data, "ownerName"),
              ownerEmail: textField(data, "ownerEmail"),
              mode: textField(data, "mode") || "PROSPECT",
            });
          }}
        >
          <Field id="name" label={t("name")}>
            <input id="name" name="name" required className={inputClass} />
          </Field>

          <Field id="domain" label={t("domain")}>
            <input
              id="domain"
              name="domain"
              required
              placeholder="wellness.hu"
              className={inputClass}
            />
          </Field>

          <Field id="slug" label={t("slug")}>
            <input id="slug" name="slug" required placeholder="wellness" className={inputClass} />
          </Field>

          <Field id="mode" label={t("mode")}>
            <select id="mode" name="mode" defaultValue="PROSPECT" className={inputClass}>
              <option value="PROSPECT">{t("modeProspect")}</option>
              <option value="INTERNAL">{t("modeInternal")}</option>
            </select>
          </Field>

          <Field id="ownerName" label={t("ownerName")}>
            <input id="ownerName" name="ownerName" required className={inputClass} />
          </Field>

          <Field id="ownerEmail" label={t("ownerEmail")}>
            <input id="ownerEmail" name="ownerEmail" type="email" required className={inputClass} />
          </Field>

          <div className="sm:col-span-2 flex flex-col gap-2">
            <ErrorText>{formError}</ErrorText>
            <button type="submit" className={buttonClass} disabled={provision.isPending}>
              {provision.isPending ? t("provisioning") : t("provision")}
            </button>
          </div>
        </form>
      </Panel>

      <Section title={t("organizations")}>
        <input
          type="search"
          value={search}
          placeholder={t("searchPlaceholder")}
          className={inputClass}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />

        {organizations.isPending ? <p>{t("loading")}</p> : null}
        {organizations.error ? <ErrorText>{t("loadFailed")}</ErrorText> : null}

        {organizations.data?.items.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">{t("empty")}</p>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left dark:border-slate-800">
                <th className="py-2 pr-4 font-medium">{t("colOrganization")}</th>
                <th className="py-2 pr-4 font-medium">{t("colOwner")}</th>
                <th className="py-2 pr-4 font-medium">{t("colStatus")}</th>
                <th className="py-2 pr-4 font-medium">{t("colSubscription")}</th>
                <th className="py-2 pr-4 font-medium">{t("colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {organizations.data?.items.map((organization) => (
                <tr
                  key={organization.id}
                  className="border-b border-slate-100 align-top dark:border-slate-900"
                >
                  <td className="py-3 pr-4">
                    <div className="font-medium">{organization.name}</div>
                    {/* The domain is the identity (§2.3), so it is shown before
                        the slug rather than after it. */}
                    <div className="text-xs text-slate-600 dark:text-slate-400">
                      {organization.domain ?? "—"}
                    </div>
                    <div className="text-xs text-slate-500">/{organization.slug}</div>
                  </td>

                  <td className="py-3 pr-4">
                    <div>{organization.owner?.email ?? "—"}</div>
                    {/* The API has always carried the owner's name and the
                        column dropped it, so an operator looking for a person
                        by the name they know them by found only an address. */}
                    {organization.owner?.name ? (
                      <div className="text-xs text-slate-600 dark:text-slate-400">
                        {organization.owner.name}
                      </div>
                    ) : null}
                    {organization.owner?.accepted === false ? (
                      <div className="text-xs text-amber-700 dark:text-amber-500">
                        {t("ownerPending")}
                      </div>
                    ) : null}
                  </td>

                  <td className="py-3 pr-4">
                    <StatusBadge status={organization.status} label={t(organization.status)} />
                    {organization.daysRemaining === null ? null : (
                      <div className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                        {t("daysRemaining", { days: organization.daysRemaining })}
                      </div>
                    )}
                  </td>

                  <td className="py-3 pr-4">
                    {organization.subscription === null ? (
                      <span className="text-slate-500">{t("noSubscription")}</span>
                    ) : (
                      <>
                        <div>{organization.subscription.plan}</div>
                        <div className="text-xs text-slate-600 dark:text-slate-400">
                          {organization.subscription.status}
                        </div>
                      </>
                    )}
                  </td>

                  <td className="py-3 pr-4">
                    <div className="flex flex-col items-start gap-1">
                      {organization.owner?.accepted === false ? (
                        <button
                          type="button"
                          className="text-xs underline"
                          disabled={resend.isPending}
                          onClick={() => {
                            resend.mutate(organization.id);
                          }}
                        >
                          {t("resendInvitation")}
                        </button>
                      ) : null}

                      {organization.status === "CLOSED" ? null : (
                        <button
                          type="button"
                          className="text-xs underline"
                          disabled={setStatus.isPending}
                          onClick={() => {
                            setStatus.mutate({
                              id: organization.id,
                              status: organization.status === "SUSPENDED" ? "ACTIVE" : "SUSPENDED",
                            });
                          }}
                        >
                          {organization.status === "SUSPENDED" ? t("reactivate") : t("suspend")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </main>
  );
}

function StatusBadge({
  status,
  label,
}: {
  status: OrganizationSummary["status"];
  label: string;
}): React.ReactElement {
  const tone =
    status === "ACTIVE"
      ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
      : status === "PENDING_SUBSCRIPTION"
        ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        : status === "SUSPENDED"
          ? "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200"
          : "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200";

  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>
  );
}
