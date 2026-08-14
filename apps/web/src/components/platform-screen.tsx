"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ApiError, apiFetch, type MeResponse } from "@/lib/api-client";
import { useSignInRedirect } from "./dashboard-shell";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { ErrorText, Field } from "./ui/field";
import { Input, Select } from "./ui/input";
import { Section } from "./ui/section";

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
        <p className="text-sm text-ink-muted">{t("subtitle")}</p>
      </header>

      {acceptUrl === null ? null : (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-xl border border-success-surface bg-success-surface text-on-success-surface p-4 text-sm"
        >
          <strong>{t("acceptLinkHeading")}</strong>
          <p className="text-ink-muted">{t("acceptLinkExplanation")}</p>
          <code className="bg-surface-sunken text-ink overflow-x-auto rounded p-2 font-mono text-xs">
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

      <Card title={t("provisionHeading")}>
        <p className="text-sm text-ink-muted">{t("provisionExplanation")}</p>

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
              // The field that was missing, and the reason every owner was
              // onboarded in Hungarian: the schema has accepted
              // `defaultLanguage` since it was written, but nothing ever sent
              // it, so its default won every time
              // (docs/phase-9-owner-language-and-return-paths.md §1).
              defaultLanguage: textField(data, "defaultLanguage") || "hu",
            });
          }}
        >
          <Field id="name" label={t("name")}>
            <Input id="name" name="name" required  />
          </Field>

          <Field id="domain" label={t("domain")}>
            <Input
              id="domain"
              name="domain"
              required
              placeholder="wellness.hu"
              
            />
          </Field>

          <Field id="slug" label={t("slug")}>
            <Input id="slug" name="slug" required placeholder="wellness"  />
          </Field>

          <Field id="mode" label={t("mode")}>
            <Select id="mode" name="mode" defaultValue="PROSPECT" >
              <option value="PROSPECT">{t("modeProspect")}</option>
              <option value="INTERNAL">{t("modeInternal")}</option>
            </Select>
          </Field>

          {/* A select rather than a text input, matching `mode`: the API takes
              a two-value enum, and a free-text field would turn a closed set
              into a 400 for anybody who typed `en-GB`. The markup default and
              the schema default are both `hu` so they cannot drift. */}
          <Field id="defaultLanguage" label={t("language")}>
            <Select
              id="defaultLanguage"
              name="defaultLanguage"
              defaultValue="hu"
              aria-describedby="defaultLanguage-hint"
              
            >
              <option value="hu">{t("languageHu")}</option>
              <option value="en">{t("languageEn")}</option>
            </Select>
            <span id="defaultLanguage-hint" className="text-xs text-ink-subtle">
              {t("languageHint")}
            </span>
          </Field>

          <Field id="ownerName" label={t("ownerName")}>
            <Input id="ownerName" name="ownerName" required  />
          </Field>

          <Field id="ownerEmail" label={t("ownerEmail")}>
            <Input id="ownerEmail" name="ownerEmail" type="email" required  />
          </Field>

          <div className="sm:col-span-2 flex flex-col gap-2">
            <ErrorText>{formError}</ErrorText>
            <Button type="submit"  disabled={provision.isPending}>
              {provision.isPending ? t("provisioning") : t("provision")}
            </Button>
          </div>
        </form>
      </Card>

      <Section title={t("organizations")}>
        <Input
          type="search"
          value={search}
          placeholder={t("searchPlaceholder")}
          
          onChange={(event) => {
            setSearch(event.target.value);
          }}
        />

        {organizations.isPending ? <p>{t("loading")}</p> : null}
        {organizations.error ? <ErrorText>{t("loadFailed")}</ErrorText> : null}

        {organizations.data?.items.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("empty")}</p>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left">
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
                  className="border-b border-line align-top"
                >
                  <td className="py-3 pr-4">
                    <div className="font-medium">{organization.name}</div>
                    {/* The domain is the identity (§2.3), so it is shown before
                        the slug rather than after it. */}
                    <div className="text-xs text-ink-muted">
                      {organization.domain ?? "—"}
                    </div>
                    <div className="text-xs text-ink-subtle">/{organization.slug}</div>
                  </td>

                  <td className="py-3 pr-4">
                    <div>{organization.owner?.email ?? "—"}</div>
                    {/* The API has always carried the owner's name and the
                        column dropped it, so an operator looking for a person
                        by the name they know them by found only an address. */}
                    {organization.owner?.name ? (
                      <div className="text-xs text-ink-muted">
                        {organization.owner.name}
                      </div>
                    ) : null}
                    {organization.owner?.accepted === false ? (
                      <div className="text-xs text-warning">
                        {t("ownerPending")}
                      </div>
                    ) : null}
                  </td>

                  <td className="py-3 pr-4">
                    <StatusBadge status={organization.status} label={t(organization.status)} />
                    {organization.daysRemaining === null ? null : (
                      <div className="mt-1 text-xs text-ink-muted">
                        {t("daysRemaining", { days: organization.daysRemaining })}
                      </div>
                    )}
                  </td>

                  <td className="py-3 pr-4">
                    {organization.subscription === null ? (
                      <span className="text-ink-subtle">{t("noSubscription")}</span>
                    ) : (
                      <>
                        <div>{organization.subscription.plan}</div>
                        <div className="text-xs text-ink-muted">
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
      ? "bg-success-surface text-on-success-surface"
      : status === "PENDING_SUBSCRIPTION"
        ? "bg-warning-surface text-on-warning-surface"
        : status === "SUSPENDED"
          ? "bg-danger-surface text-on-danger-surface"
          : "bg-surface-sunken text-ink-muted";

  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>
  );
}
