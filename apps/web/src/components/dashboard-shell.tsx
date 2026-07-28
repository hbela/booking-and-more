"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { signOut } from "@/lib/auth-client";
import { apiFetch, type MeResponse, type TenantSummary } from "@/lib/api-client";

/**
 * Everything the staff screens share: which tenant we are in, who is signed in,
 * what they may do, and the navigation between the catalogue screens
 * (tech-impl §28).
 *
 * ## Why the active tenant lives on the server
 *
 * Epic 1's dashboard kept the selected tenant in React state, which was fine
 * while there was one screen. With four, that choice has to survive a
 * navigation, and the obvious fixes — a context provider, localStorage — both
 * end up with a client-side idea of "current tenant" that can disagree with the
 * server's. So the switcher calls `POST /v1/tenants/:id/activate` and the answer
 * is read back from `/v1/me`. The stored value is still only a convenience: the
 * API re-resolves membership on every single request regardless.
 */

export interface DashboardContext {
  tenantId: string | undefined;
  tenants: TenantSummary[];
  me: MeResponse | undefined;
  isPending: boolean;
  /** Advisory only — the server authorises every action again. */
  can: (permission: string) => boolean;
}

export function useDashboardContext(): DashboardContext {
  const tenants = useQuery({
    queryKey: ["tenants"],
    queryFn: () => apiFetch<{ items: TenantSummary[] }>("/v1/tenants"),
  });

  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<MeResponse>("/v1/me"),
  });

  // `/v1/me` reports the session's tenant. Falling back to the first one the
  // user belongs to covers the request right after sign-up, before anything has
  // been activated.
  const tenantId = me.data?.tenant?.id ?? tenants.data?.items[0]?.id;

  return {
    tenantId,
    tenants: tenants.data?.items ?? [],
    me: me.data,
    isPending: tenants.isPending || me.isPending,
    can: (permission) => me.data?.permissions.includes(permission) ?? false,
  };
}

/**
 * Send a signed-out visitor to sign-in.
 *
 * In an effect, never during render. Calling `router.push()` while rendering
 * asks React to update the Router component in the middle of rendering a
 * different one, which it refuses: "Cannot update a component while rendering a
 * different component". It happened to work on the Epic 1 dashboard because the
 * redirect only fired on a query error, so nobody hit it on the happy path.
 *
 * Every screen still renders its loading placeholder while the navigation is in
 * flight — a redirect is a request, not an early return.
 */
export function useSignInRedirect(signedOut: boolean): void {
  const router = useRouter();

  useEffect(() => {
    if (signedOut) {
      router.push("/sign-in");
    }
  }, [signedOut, router]);
}

const NAV = [
  { href: "/dashboard", key: "overview" as const },
  { href: "/dashboard/providers", key: "providers" as const },
  { href: "/dashboard/services", key: "services" as const },
  { href: "/dashboard/locations", key: "locations" as const },
];

export function DashboardShell({
  context,
  children,
}: {
  context: DashboardContext;
  children: React.ReactNode;
}): React.ReactElement {
  const t = useTranslations("dashboard");
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();

  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          {context.me ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {context.me.user.name} · {context.me.user.email}
              {context.me.membership ? ` · ${context.me.membership.role}` : ""}
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          {context.tenants.length > 1 ? (
            <label htmlFor="tenant" className="flex items-center gap-2 text-sm">
              <span className="sr-only">{t("tenant")}</span>
              <select
                id="tenant"
                value={context.tenantId ?? ""}
                onChange={(event) => {
                  const next = event.target.value;
                  void apiFetch(`/v1/tenants/${next}/activate`, { method: "POST" }).then(() => {
                    // Everything on screen is tenant-scoped, so nothing cached
                    // survives the switch.
                    void queryClient.invalidateQueries();
                  });
                }}
                className="rounded-md border border-slate-300 bg-transparent px-3 py-1.5 dark:border-slate-700"
              >
                {context.tenants.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

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
        </div>
      </header>

      {context.tenantId ? (
        <nav aria-label={t("sections")}>
          <ul className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
            {NAV.map((item) => {
              const current = pathname === item.href;

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    // aria-current is what a screen reader announces; the
                    // underline is only its visual echo.
                    aria-current={current ? "page" : undefined}
                    className={`inline-block border-b-2 px-3 py-2 text-sm ${
                      current
                        ? "border-brand-600 font-medium"
                        : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                    }`}
                  >
                    {t(item.key)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}

      {children}
    </div>
  );
}

/** Shared chrome for a catalogue screen: heading, error slot, and a table. */
export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** A form panel with a heading. */
export function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-slate-200 p-5 dark:border-slate-800">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function ErrorText({ children }: { children: React.ReactNode }): React.ReactElement | null {
  if (!children) return null;

  return (
    <p role="alert" className="text-sm text-red-600 dark:text-red-400">
      {children}
    </p>
  );
}

export function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "rounded-md border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700";

export const buttonClass =
  "self-start rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60";
