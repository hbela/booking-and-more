"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ApiError, apiFetch, type Member, type Paginated, type Provider } from "@/lib/api-client";
import { resolveDiaryState } from "@/lib/member-diary";
import { DashboardShell, useDashboardContext, useSignInRedirect } from "./dashboard-shell";
import { Button, ButtonLink } from "./ui/button";
import { Card } from "./ui/card";
import { ErrorText, Field } from "./ui/field";
import { Input, Select } from "./ui/input";
import { Section } from "./ui/section";
import { BusinessKnowledge } from "./business-knowledge";
import { ArrowUpRight, CalendarDays, Clock3, Bot } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { navFor } from "@/lib/dashboard-nav";

/**
 * Dashboard overview: business knowledge and members.
 *
 * Epic 2 moved the header, tenant switcher and navigation into
 * {@link DashboardShell}, shared with the catalogue screens. What is left here
 * is the members panel this screen actually owns.
 *
 * Controls are shown or hidden from `me.permissions`, which the API derives from
 * the same role table the guards use. That keeps the UI honest — but it is only
 * a UI affordance. Every action is authorised again server-side, so hiding a
 * button is never the thing that stops an unauthorised call.
 */
export function Dashboard(): React.ReactElement {
  const t = useTranslations("dashboard");
  const context = useDashboardContext();
  useSignInRedirect(!context.isPending && !context.me);
  const queryClient = useQueryClient();

  const canManageMembers = context.can("member:manage");
  const canReadMembers = context.can("member:read");

  const members = useQuery({
    queryKey: ["members", context.tenantId],
    queryFn: () => apiFetch<{ items: Member[] }>("/v1/members", { tenantId: context.tenantId }),
    enabled: Boolean(context.tenantId) && canReadMembers,
  });

  // Only to name a member's diary in the table, and to offer the unlinked ones
  // when repairing a membership that has none. Archived providers are excluded
  // because `linkProvider` refuses them anyway.
  const providers = useQuery({
    queryKey: ["providers", context.tenantId, false],
    queryFn: () =>
      apiFetch<Paginated<Provider>>("/v1/providers?limit=100", { tenantId: context.tenantId }),
    enabled: Boolean(context.tenantId) && canManageMembers,
  });

  const takenProviderIds = new Set(
    (members.data?.items ?? [])
      .map((member) => member.providerId)
      .filter((id): id is string => id !== null),
  );

  // Almost always "not signed in" — send them to sign-in rather than showing a
  // dead dashboard. The redirect itself happens in an effect, not here.
  if (context.isPending || !context.me) {
    return <p className="p-8">{t("loading")}</p>;
  }

  return (
    <DashboardShell context={context}>
      {context.tenants.length === 0 ? (
        // A platform admin holds no memberships by design (CLAUDE.md rule 9),
        // so `tenants` is permanently empty for them and this branch is the
        // only thing they would ever see here. Offering them the create form
        // would be offering an action the API refuses on purpose —
        // `canHoldTenantMembership` rejects it in tenant.routes.ts — so they
        // are pointed at the screen that is actually theirs instead.
        context.me.user.isPlatformAdmin ? (
          <PlatformAdminPanel />
        ) : (
          <CreateTenantPanel
            onCreated={() => {
              void queryClient.invalidateQueries();
            }}
          />
        )
      ) : (
        <>
          {!context.awaitingSubscription ? (
            <div className="grid gap-4 sm:grid-cols-3">
              {navFor(context.me)
                .filter((item) => ["bookings", "availability", "assistant"].includes(item.key))
                .map((item) => {
                  const Glyph =
                    item.key === "bookings"
                      ? CalendarDays
                      : item.key === "availability"
                        ? Clock3
                        : Bot;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="group flex min-h-36 flex-col justify-between gap-6 rounded-xl border border-line bg-surface-raised p-6 transition-colors hover:border-primary hover:bg-primary-surface"
                    >
                      <span className="flex items-center justify-between gap-4">
                        <span className="flex size-11 items-center justify-center rounded-xl bg-primary-surface text-on-primary-surface">
                          <Glyph size={22} aria-hidden="true" />
                        </span>
                        <ArrowUpRight
                          size={20}
                          aria-hidden="true"
                          className="text-ink-muted group-hover:text-primary"
                        />
                      </span>
                      <span className="font-display text-lg font-semibold">{t(item.key)}</span>
                    </Link>
                  );
                })}
            </div>
          ) : null}
          {context.awaitingSubscription && context.me.tenant ? (
            <PendingPanel
              organizationName={context.me.tenant.name}
              daysRemaining={context.me.tenant.daysRemaining}
            />
          ) : null}

          {context.tenantId &&
          context.me.features.assistant &&
          context.can("conversation:read:all") ? (
            <BusinessKnowledge
              key={context.tenantId}
              tenantId={context.tenantId}
              canManage={context.can("assistant:manage")}
            />
          ) : null}

          {canReadMembers ? (
            <Section title={t("members")} variant="card">
              <div className="overflow-x-auto">
                <table className="w-full min-w-md text-left text-sm">
                  <thead className="border-b border-line bg-surface-sunken">
                    <tr>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        {t("name")}
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        {t("email")}
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        {t("role")}
                      </th>
                      {/* Which diary a member holds, and the way to repair one
                          that holds none. A PROVIDER with no diary looks
                          entirely healthy in a name/email/role table while
                          being unable to do anything at all. */}
                      <th scope="col" className="py-2 font-medium">
                        {t("diary")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.data?.items.map((member) => (
                      <tr
                        key={member.id}
                        className="h-14 border-b border-line hover:bg-surface-raised"
                      >
                        <td className="py-2 pr-4">{member.user.name}</td>
                        <td className="py-2 pr-4">{member.user.email}</td>
                        <td className="py-2 pr-4">{member.role}</td>
                        <td className="py-2">
                          <MemberDiary
                            member={member}
                            providers={providers.data?.items ?? null}
                            takenProviderIds={takenProviderIds}
                            tenantId={context.tenantId}
                            canManage={canManageMembers}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          ) : null}
        </>
      )}
    </DashboardShell>
  );
}

/**
 * What a pending owner sees first.
 * docs/phase-9-subscription-and-activation.md §2.3.
 *
 * Three steps in the order they happen, of which exactly one is actionable.
 * The point is that the owner arrives at an empty organization they cannot yet
 * configure, and that screen is the product's first impression — so it explains
 * the sequence rather than leaving them to discover it by clicking things that
 * return 403.
 */
function PendingPanel({
  organizationName,
  daysRemaining,
}: {
  organizationName: string;
  daysRemaining: number | null;
}): React.ReactElement {
  const t = useTranslations("dashboard");

  const steps = [
    { key: "stepSubscribe" as const, done: false, active: true },
    { key: "stepConfigure" as const, done: false, active: false },
    { key: "stepTakeBookings" as const, done: false, active: false },
  ];

  return (
    <Card title={t("pendingTitle", { organization: organizationName })}>
      <p className="text-sm text-ink-muted">{t("pendingIntro")}</p>

      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={step.key} className="flex gap-3 text-sm">
            <span
              aria-hidden="true"
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                step.active ? "bg-primary text-white" : "bg-surface-sunken text-ink-subtle"
              }`}
            >
              {index + 1}
            </span>
            <span className={step.active ? "" : "text-ink-subtle"}>{t(step.key)}</span>
          </li>
        ))}
      </ol>

      {/* Null means no deadline at all — an internal organization — which is
          not the same as none left, so nothing is rendered rather than
          "0 days" (phase-9 §2.2). */}
      {daysRemaining === null ? null : (
        <p className="text-sm text-ink-muted">{t("daysRemaining", { days: daysRemaining })}</p>
      )}

      <ButtonLink href="/dashboard/subscription">{t("subscribeCta")}</ButtonLink>
    </Card>
  );
}

/**
 * What an operator of the platform sees if they land on the tenant dashboard.
 *
 * Sign-in sends them to `/admin` now, so this is the catch for the ways round
 * that — a bookmark, a link from a colleague, the back button. Not a redirect:
 * a platform admin can legitimately be here, and bouncing them would make the
 * URL unusable.
 *
 * Strings come from the `admin` namespace rather than `dashboard` because the
 * `/admin` landing page says the same thing, and one sentence maintained twice
 * is one sentence that drifts.
 */
function PlatformAdminPanel(): React.ReactElement {
  const t = useTranslations("admin");

  return (
    <Card title={t("platformAdminTitle")}>
      <p className="text-sm text-ink-muted">{t("platformAdminHint")}</p>

      <ButtonLink href="/admin">{t("platformAdminLink")}</ButtonLink>
    </Card>
  );
}

function CreateTenantPanel({ onCreated }: { onCreated: () => void }): React.ReactElement {
  const t = useTranslations("dashboard");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => apiFetch("/v1/tenants", { method: "POST", body: { name, slug } }),
    onSuccess: onCreated,
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  return (
    <Card title={t("createTenant")}>
      <p className="text-sm text-ink-muted">{t("createTenantHint")}</p>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        <Field id="tenant-name" label={t("name")}>
          <Input
            id="tenant-name"
            value={name}
            onChange={(event) => {
              const value = event.target.value;
              setName(value);
              // Suggest a slug, but leave it editable — it becomes a public URL.
              setSlug(
                value
                  .toLowerCase()
                  .normalize("NFD")
                  .replace(/[̀-ͯ]/g, "")
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, ""),
              );
            }}
            required
          />
        </Field>

        <Field id="tenant-slug" label={t("slug")}>
          <Input
            id="tenant-slug"
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
            }}
            required
            className="font-mono"
          />
        </Field>

        <ErrorText>{error}</ErrorText>

        <Button type="submit" disabled={mutation.isPending}>
          {t("create")}
        </Button>
      </form>
    </Card>
  );
}

/**
 * Which diary a member holds, and the repair when they hold none.
 *
 * This exists because of a real trap. Until now the members table showed name,
 * email and role, in which a `PROVIDER` whose membership names no diary looks
 * completely healthy — while holding three `:own` permissions that match
 * nothing, so they can do nothing and nothing says why.
 *
 * `PATCH /v1/members/:membershipId { providerId }` has existed since Epic 2 and
 * no screen ever called it. Provider invitations now carry the diary from the
 * start (docs/phase-9-provider-onboarding.md), so nothing *new* should reach
 * this state — but memberships created before that, or by the generic invite
 * panel while it still offered PROVIDER, are stranded without it.
 */
function MemberDiary({
  member,
  providers,
  takenProviderIds,
  tenantId,
  canManage,
}: {
  member: Member;
  /**
   * The tenant's diaries, or `null` when we do not have them — the query is
   * only enabled for a members-manager, and is undefined until it lands.
   * `null` is not `[]`: see {@link resolveDiaryState}.
   */
  providers: Provider[] | null;
  /** Diaries another member already holds — at most one login per diary. */
  takenProviderIds: Set<string>;
  tenantId: string | undefined;
  canManage: boolean;
}): React.ReactElement {
  const t = useTranslations("dashboard");
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const link = useMutation({
    mutationFn: (providerId: string) =>
      apiFetch(`/v1/members/${member.id}`, {
        method: "PATCH",
        tenantId,
        body: { providerId },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["members"] });
      // Their own navigation gains the Availability item from `me`.
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  const state = resolveDiaryState({ member, providers });

  switch (state.kind) {
    // Named rather than ticked: "which diary" is the useful answer.
    case "named":
      return <span>{state.displayName}</span>;
    // Linked, but unnameable — see resolveDiaryState for why that is not the
    // same as archived, and what claiming otherwise did to every provider.
    case "linked":
      return <span>{t("diaryLinked")}</span>;
    case "archived":
      return <span>{t("diaryArchived")}</span>;
    case "none":
      return <span className="text-ink-subtle">—</span>;
    case "missing":
      break;
  }

  // At most one login per diary, and archived diaries are refused by
  // `linkProvider`. The unique index is what enforces the first; this only
  // avoids offering a choice the server would reject.
  const available = (providers ?? []).filter(
    (provider) => provider.archivedAt === null && !takenProviderIds.has(provider.id),
  );

  if (!canManage) {
    return <span className="text-warning">{t("diaryMissing")}</span>;
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2">
        <span className="sr-only">{t("linkDiary")}</span>
        <Select
          defaultValue=""
          disabled={link.isPending}
          onChange={(event) => {
            if (event.target.value === "") return;
            setError(null);
            link.mutate(event.target.value);
          }}
        >
          <option value="">{t("linkDiaryPrompt")}</option>
          {available.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.displayName}
            </option>
          ))}
        </Select>
      </label>
      {available.length === 0 ? (
        <span className="text-xs text-ink-subtle">{t("noDiaryToLink")}</span>
      ) : null}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
