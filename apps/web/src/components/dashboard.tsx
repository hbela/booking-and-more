"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import {
  ApiError,
  apiFetch,
  type Invitation,
  type Member,
  type Paginated,
  type Provider,
} from "@/lib/api-client";
import {
  DashboardShell,
  ErrorText,
  Field,
  Notice,
  NoticeLink,
  Panel,
  Section,
  buttonClass,
  inputClass,
  useDashboardContext,
  useSignInRedirect,
} from "./dashboard-shell";

/**
 * Dashboard overview: who is here, and who to invite.
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

  const invitations = useQuery({
    queryKey: ["invitations", context.tenantId],
    queryFn: () =>
      apiFetch<{ items: Invitation[] }>("/v1/members/invitations", { tenantId: context.tenantId }),
    enabled: Boolean(context.tenantId) && canManageMembers,
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
          {context.awaitingSubscription && context.me.tenant ? (
            <PendingPanel
              organizationName={context.me.tenant.name}
              daysRemaining={context.me.tenant.daysRemaining}
            />
          ) : null}

          {canReadMembers ? (
            <Section title={t("members")}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-md text-left text-sm">
                  <thead className="border-b border-slate-200 dark:border-slate-800">
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
                        className="border-b border-slate-100 dark:border-slate-900"
                      >
                        <td className="py-2 pr-4">{member.user.name}</td>
                        <td className="py-2 pr-4">{member.user.email}</td>
                        <td className="py-2 pr-4">{member.role}</td>
                        <td className="py-2">
                          <MemberDiary
                            member={member}
                            providers={providers.data?.items ?? []}
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

          {canManageMembers && context.tenantId ? (
            <InvitePanel
              tenantId={context.tenantId}
              invitations={invitations.data?.items ?? []}
              onInvited={() => {
                void queryClient.invalidateQueries({ queryKey: ["invitations"] });
              }}
            />
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
    <Panel title={t("pendingTitle", { organization: organizationName })}>
      <p className="text-sm text-slate-600 dark:text-slate-400">{t("pendingIntro")}</p>

      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={step.key} className="flex gap-3 text-sm">
            <span
              aria-hidden="true"
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                step.active
                  ? "bg-brand-600 text-white"
                  : "bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
              }`}
            >
              {index + 1}
            </span>
            <span className={step.active ? "" : "text-slate-500 dark:text-slate-400"}>
              {t(step.key)}
            </span>
          </li>
        ))}
      </ol>

      {/* Null means no deadline at all — an internal organization — which is
          not the same as none left, so nothing is rendered rather than
          "0 days" (phase-9 §2.2). */}
      {daysRemaining === null ? null : (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {t("daysRemaining", { days: daysRemaining })}
        </p>
      )}

      <Link href="/dashboard/subscription" className={buttonClass}>
        {t("subscribeCta")}
      </Link>
    </Panel>
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
    <Panel title={t("platformAdminTitle")}>
      <p className="text-sm text-slate-600 dark:text-slate-400">{t("platformAdminHint")}</p>

      <Link href="/admin" className={buttonClass}>
        {t("platformAdminLink")}
      </Link>
    </Panel>
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
    <Panel title={t("createTenant")}>
      <p className="text-sm text-slate-600 dark:text-slate-400">{t("createTenantHint")}</p>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        <Field id="tenant-name" label={t("name")}>
          <input
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
            className={inputClass}
          />
        </Field>

        <Field id="tenant-slug" label={t("slug")}>
          <input
            id="tenant-slug"
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
            }}
            required
            className={`${inputClass} font-mono`}
          />
        </Field>

        <ErrorText>{error}</ErrorText>

        <button type="submit" disabled={mutation.isPending} className={buttonClass}>
          {t("create")}
        </button>
      </form>
    </Panel>
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
  providers: Provider[];
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

  const linked = providers.find((provider) => provider.id === member.providerId);

  if (member.providerId !== null) {
    // Named rather than ticked: "which diary" is the useful answer, and a
    // provider archived since linking would otherwise show as a blank cell.
    return <span>{linked?.displayName ?? t("diaryArchived")}</span>;
  }

  // Only PROVIDER memberships need one. An owner or an assistant with no diary
  // is the normal case and deserves no warning.
  if (member.role !== "PROVIDER") {
    return <span className="text-slate-400 dark:text-slate-600">—</span>;
  }

  // At most one login per diary, and archived diaries are refused by
  // `linkProvider`. The unique index is what enforces the first; this only
  // avoids offering a choice the server would reject.
  const available = providers.filter(
    (provider) => provider.archivedAt === null && !takenProviderIds.has(provider.id),
  );

  if (!canManage) {
    return <span className="text-amber-700 dark:text-amber-500">{t("diaryMissing")}</span>;
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2">
        <span className="sr-only">{t("linkDiary")}</span>
        <select
          defaultValue=""
          disabled={link.isPending}
          onChange={(event) => {
            if (event.target.value === "") return;
            setError(null);
            link.mutate(event.target.value);
          }}
          className={inputClass}
        >
          <option value="">{t("linkDiaryPrompt")}</option>
          {available.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.displayName}
            </option>
          ))}
        </select>
      </label>
      {available.length === 0 ? (
        <span className="text-xs text-slate-500">{t("noDiaryToLink")}</span>
      ) : null}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

function InvitePanel({
  tenantId,
  invitations,
  onInvited,
}: {
  tenantId: string;
  invitations: Invitation[];
  onInvited: () => void;
}): React.ReactElement {
  const t = useTranslations("dashboard");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("ASSISTANT");
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<{ acceptUrl: string }>("/v1/members/invitations", {
        method: "POST",
        tenantId,
        body: { email, role },
      }),
    onSuccess: (result) => {
      setAcceptUrl(result.acceptUrl);
      setEmail("");
      onInvited();
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  return (
    <Panel title={t("invite")}>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setAcceptUrl(null);
          mutation.mutate();
        }}
      >
        <div className="flex-1">
          <Field id="invite-email" label={t("email")}>
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              required
              className={`${inputClass} w-full`}
            />
          </Field>
        </div>

        <Field id="invite-role" label={t("role")}>
          <select
            id="invite-role"
            value={role}
            onChange={(event) => {
              setRole(event.target.value);
            }}
            className={inputClass}
          >
            {/* PROVIDER is deliberately absent, and the API refuses it here
                too. This panel has no diary to attach, so a provider invited
                from it joins holding three `:own` permissions that match
                nothing — able to sign in and do absolutely nothing, with no
                error to explain it. Providers are invited from their own row,
                where the diary is unambiguous. */}
            {["OWNER", "ADMIN", "ASSISTANT"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>

        <Notice>
          {t.rich("inviteProviderElsewhere", {
            link: (chunks) => <NoticeLink href="/dashboard/providers">{chunks}</NoticeLink>,
          })}
        </Notice>

        <button
          type="submit"
          disabled={mutation.isPending}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {t("sendInvite")}
        </button>
      </form>

      <ErrorText>{error}</ErrorText>

      {acceptUrl ? (
        <div className="rounded-md bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
          {/* Shown once. Only a hash is stored, so this link cannot be recovered
              later. Epic 5 emails it instead of putting it on screen. */}
          <p className="font-medium">{t("inviteLinkOnce")}</p>
          <code className="mt-1 block break-all font-mono text-xs">{acceptUrl}</code>
        </div>
      ) : null}

      {invitations.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="text-slate-600 dark:text-slate-400">
              {invitation.email} · {invitation.role} · {t("expires")}{" "}
              {new Date(invitation.expiresAt).toLocaleDateString()}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}
