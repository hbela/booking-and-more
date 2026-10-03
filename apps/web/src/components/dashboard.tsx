"use client";

import { PageLoading } from "./ui/loading";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ApiError, apiFetch, type Member, type Paginated, type Provider } from "@/lib/api-client";
import { resolveDiaryState } from "@/lib/member-diary";
import { DashboardShell, useDashboardContext, useSignInRedirect } from "./dashboard-shell";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { ErrorText, FormField } from "./ui/form-field";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Section } from "./ui/section";
import { useConfirm } from "./ui/confirm-dialog";
import {
  RowButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { BusinessKnowledge } from "./business-knowledge";
import { PatientQrCodes } from "./patient-qr-codes";
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
    return <PageLoading label={t("loading")} />;
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

          {!context.awaitingSubscription && context.me.tenant ? (
            <PatientQrCodes
              slug={context.me.tenant.slug}
              assistant={context.me.features.assistant}
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
              <Table className="w-full min-w-md">
                <TableHeader className="bg-surface-sunken">
                  <TableRow>
                    <TableHead>{t("name")}</TableHead>
                    <TableHead>{t("email")}</TableHead>
                    <TableHead>{t("role")}</TableHead>
                    {/* Which diary a member holds, and the way to repair one
                          that holds none. A PROVIDER with no diary looks
                          entirely healthy in a name/email/role table while
                          being unable to do anything at all. */}
                    <TableHead>{t("diary")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.data?.items.map((member) => (
                    <TableRow key={member.id} className="h-14 hover:bg-surface-raised">
                      <TableCell>{member.user.name}</TableCell>
                      <TableCell>{member.user.email}</TableCell>
                      <TableCell>{member.role}</TableCell>
                      <TableCell>
                        <MemberDiary
                          member={member}
                          providers={providers.data?.items ?? null}
                          takenProviderIds={takenProviderIds}
                          tenantId={context.tenantId}
                          canManage={canManageMembers}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
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
    <Card>
      <CardHeader>
        <CardTitle>{t("pendingTitle", { organization: organizationName })}</CardTitle>
      </CardHeader>
      <CardContent>
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

        <Button asChild>
          <Link href="/dashboard/subscription">{t("subscribeCta")}</Link>
        </Button>
      </CardContent>
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
    <Card>
      <CardHeader>
        <CardTitle>{t("platformAdminTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-ink-muted">{t("platformAdminHint")}</p>

        <Button asChild>
          <Link href="/admin">{t("platformAdminLink")}</Link>
        </Button>
      </CardContent>
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
    <Card>
      <CardHeader>
        <CardTitle>{t("createTenant")}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-ink-muted">{t("createTenantHint")}</p>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            mutation.mutate();
          }}
        >
          <FormField id="tenant-name" label={t("name")}>
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
          </FormField>

          <FormField id="tenant-slug" label={t("slug")}>
            <Input
              id="tenant-slug"
              value={slug}
              onChange={(event) => {
                setSlug(event.target.value);
              }}
              required
              className="font-mono"
            />
          </FormField>

          <ErrorText>{error}</ErrorText>

          <Button type="submit" disabled={mutation.isPending}>
            {t("create")}
          </Button>
        </form>
      </CardContent>
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
  const { confirm, confirmDialog } = useConfirm();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const link = useMutation({
    mutationFn: (providerId: string | null) =>
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

  // An owner or administrator holds a diary by choice — they also treat
  // patients — so it can be let go again from here. A PROVIDER's cannot: their
  // diary is the whole of their job, and unlinking would strand them with
  // `:own` permissions over nothing (docs/phase-9-owner-as-provider.md §2.3).
  const unlink =
    canManage && member.role !== "PROVIDER" ? (
      <RowButton
        disabled={link.isPending}
        onClick={() => {
          confirm({
            title: t("unlinkDiaryConfirm", { name: member.user.name }),
            confirmLabel: t("unlinkDiary"),
            destructive: true,
            onConfirm: () => {
              setError(null);
              link.mutate(null);
            },
          });
        }}
      >
        {t("unlinkDiary")}
      </RowButton>
    ) : null;

  const linked = (label: React.ReactNode): React.ReactElement =>
    unlink === null ? (
      <span>{label}</span>
    ) : (
      <div className="flex flex-col items-start gap-1">
        <span>{label}</span>
        {unlink}
        {confirmDialog}
        <ErrorText>{error}</ErrorText>
      </div>
    );

  switch (state.kind) {
    // Named rather than ticked: "which diary" is the useful answer.
    case "named":
      return linked(state.displayName);
    // Linked, but unnameable — see resolveDiaryState for why that is not the
    // same as archived, and what claiming otherwise did to every provider.
    case "linked":
      return linked(t("diaryLinked"));
    case "archived":
      return linked(t("diaryArchived"));
    case "none":
      return <span className="text-ink-subtle">—</span>;
    case "optional":
      if (!canManage) return <span className="text-ink-subtle">—</span>;
      break;
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

  const optional = state.kind === "optional";

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2">
        <span className="sr-only">{t("linkDiary")}</span>
        <NativeSelect
          defaultValue=""
          disabled={link.isPending}
          onChange={(event) => {
            if (event.target.value === "") return;
            setError(null);
            link.mutate(event.target.value);
          }}
        >
          <option value="">{optional ? t("linkDiaryOptionalPrompt") : t("linkDiaryPrompt")}</option>
          {available.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.displayName}
            </option>
          ))}
        </NativeSelect>
      </label>
      {available.length === 0 && !optional ? (
        <span className="text-xs text-ink-subtle">{t("noDiaryToLink")}</span>
      ) : null}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
