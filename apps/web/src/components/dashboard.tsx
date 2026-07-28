"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { signOut } from "@/lib/auth-client";
import {
  ApiError,
  apiFetch,
  type Invitation,
  type Member,
  type MeResponse,
  type TenantSummary,
} from "@/lib/api-client";

/**
 * Staff dashboard for Epic 1: who am I, which tenant, who else is here, and
 * invite someone.
 *
 * Controls are shown or hidden from `me.permissions`, which the API derives
 * from the same role table the guards use. That keeps the UI honest — but it is
 * only a UI affordance. Every action is authorised again server-side, so hiding
 * a button is never the thing that stops an unauthorised call.
 */
export function Dashboard(): React.ReactElement {
  const t = useTranslations("dashboard");
  const router = useRouter();
  const queryClient = useQueryClient();

  const [tenantId, setTenantId] = useState<string | undefined>(undefined);

  const tenants = useQuery({
    queryKey: ["tenants"],
    queryFn: () => apiFetch<{ items: TenantSummary[] }>("/v1/tenants"),
  });

  const activeTenantId = tenantId ?? tenants.data?.items[0]?.id;

  const me = useQuery({
    queryKey: ["me", activeTenantId],
    queryFn: () => apiFetch<MeResponse>("/v1/me", { tenantId: activeTenantId }),
  });

  const canManageMembers = me.data?.permissions.includes("member:manage") ?? false;
  const canReadMembers = me.data?.permissions.includes("member:read") ?? false;

  const members = useQuery({
    queryKey: ["members", activeTenantId],
    queryFn: () => apiFetch<{ items: Member[] }>("/v1/members", { tenantId: activeTenantId }),
    enabled: Boolean(activeTenantId) && canReadMembers,
  });

  const invitations = useQuery({
    queryKey: ["invitations", activeTenantId],
    queryFn: () =>
      apiFetch<{ items: Invitation[] }>("/v1/members/invitations", { tenantId: activeTenantId }),
    enabled: Boolean(activeTenantId) && canManageMembers,
  });

  if (tenants.isPending) {
    return <p className="p-8">{t("loading")}</p>;
  }

  if (tenants.isError) {
    // Almost always "not signed in" — send them to sign-in rather than showing
    // a dead dashboard.
    router.push("/sign-in");
    return <p className="p-8">{t("loading")}</p>;
  }

  const tenantList = tenants.data.items;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          {me.data ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {me.data.user.name} · {me.data.user.email}
              {me.data.membership ? ` · ${me.data.membership.role}` : ""}
            </p>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => {
            void signOut().then(() => {
              router.push("/sign-in");
            });
          }}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
        >
          {t("signOut")}
        </button>
      </header>

      {tenantList.length === 0 ? (
        <CreateTenantPanel
          onCreated={() => {
            void queryClient.invalidateQueries();
          }}
        />
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <label htmlFor="tenant" className="text-sm font-medium">
              {t("tenant")}
            </label>
            <select
              id="tenant"
              value={activeTenantId ?? ""}
              onChange={(event) => {
                setTenantId(event.target.value);
              }}
              className="max-w-sm rounded-md border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700"
            >
              {tenantList.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name} ({tenant.role.toLowerCase()})
                </option>
              ))}
            </select>
          </section>

          {canReadMembers ? (
            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold">{t("members")}</h2>

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
                      <th scope="col" className="py-2 font-medium">
                        {t("role")}
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
                        <td className="py-2">{member.role}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {canManageMembers && activeTenantId ? (
            <InvitePanel
              tenantId={activeTenantId}
              invitations={invitations.data?.items ?? []}
              onInvited={() => {
                void queryClient.invalidateQueries({ queryKey: ["invitations", activeTenantId] });
              }}
            />
          ) : null}
        </>
      )}
    </main>
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
    <section className="flex flex-col gap-4 rounded-xl border border-slate-200 p-5 dark:border-slate-800">
      <h2 className="text-lg font-semibold">{t("createTenant")}</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400">{t("createTenantHint")}</p>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          mutation.mutate();
        }}
      >
        <label htmlFor="tenant-name" className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("name")}</span>
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
            className="rounded-md border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700"
          />
        </label>

        <label htmlFor="tenant-slug" className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("slug")}</span>
          <input
            id="tenant-slug"
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
            }}
            required
            className="rounded-md border border-slate-300 bg-transparent px-3 py-2 font-mono dark:border-slate-700"
          />
        </label>

        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={mutation.isPending}
          className="self-start rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {t("create")}
        </button>
      </form>
    </section>
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
    <section className="flex flex-col gap-4 rounded-xl border border-slate-200 p-5 dark:border-slate-800">
      <h2 className="text-lg font-semibold">{t("invite")}</h2>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setAcceptUrl(null);
          mutation.mutate();
        }}
      >
        <label htmlFor="invite-email" className="flex flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">{t("email")}</span>
          <input
            id="invite-email"
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            required
            className="rounded-md border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700"
          />
        </label>

        <label htmlFor="invite-role" className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("role")}</span>
          <select
            id="invite-role"
            value={role}
            onChange={(event) => {
              setRole(event.target.value);
            }}
            className="rounded-md border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700"
          >
            {["OWNER", "ADMIN", "PROVIDER", "ASSISTANT"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          disabled={mutation.isPending}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {t("sendInvite")}
        </button>
      </form>

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

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
    </section>
  );
}
