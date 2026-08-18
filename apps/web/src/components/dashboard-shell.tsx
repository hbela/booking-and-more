"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { signOut } from "@/lib/auth-client";
import { apiFetch, type MeResponse, type TenantSummary } from "@/lib/api-client";
import { navFor } from "@/lib/dashboard-nav";
import { LocaleSwitcher } from "./locale-switcher";
import { ThemeToggle } from "./ui/theme-toggle";

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
  /**
   * Whether the organization is waiting for its first subscription.
   *
   * Deliberately a property of the *tenant*, not of the user: the owner holds
   * every permission there is, and what is missing is a paid subscription. A
   * `can()` check here would be both wrong and misleading, since it would imply
   * the fix is a role change (phase-9-subscription-and-activation.md §2.1).
   */
  awaitingSubscription: boolean;
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
    awaitingSubscription: me.data?.tenant?.status === "PENDING_SUBSCRIPTION",
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

/** One node, referenced by every disabled item, so the reason is announced. */
const GATE_HINT_ID = "nav-gate-reason";

export function DashboardShell({
  context,
  children,
}: {
  context: DashboardContext;
  children: React.ReactNode;
}): React.ReactElement {
  const t = useTranslations("dashboard");
  const common = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();

  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          {context.me ? (
            <p className="text-sm text-ink-muted">
              {context.me.user.name} · {context.me.user.email}
              {context.me.membership ? ` · ${context.me.membership.role}` : ""}
            </p>
          ) : null}
        </div>

        {/* Language and appearance belong here, not only on the signed-out
            root and the platform screen: a signed-in tenant user never visits
            either, so until Epic 11 put them here they had no way to change
            language or theme from inside the app at all. `items-end` because
            both controls caption their select, and the tenant switcher and
            sign-out button do not — aligning tops would stagger them. */}
        <div className="flex flex-wrap items-end gap-3">
          <LocaleSwitcher label={common("language")} />
          <ThemeToggle />

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
                className="rounded-md border border-line-strong bg-transparent px-3 py-1.5"
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
            className="rounded-md border border-line-strong px-3 py-1.5 text-sm"
          >
            {t("signOut")}
          </button>
        </div>
      </header>

      {/* `!isPending` is not belt and braces: `tenantId` can resolve from the
          tenants query before `me` lands, and `can()` answers false until then —
          so without it the nav paints with one item and then grows, moving the
          target somebody is already reaching for. */}
      {context.tenantId && !context.isPending ? (
        <nav aria-label={t("sections")}>
          <ul className="flex flex-wrap gap-1 border-b border-line">
            {/* Already filtered — both gates live in lib/dashboard-nav.ts, so
                this maps and does not decide. */}
            {navFor(context.me).map((item) => {
              const current = pathname === item.href;
              const gated = context.awaitingSubscription && !item.alwaysAvailable;

              // Rendered as a span, not a dimmed Link. An anchor stays
              // focusable and still activates on Enter however it is painted,
              // so a "disabled" one would navigate anyway — to a screen that
              // 403s, which is the failure this exists to remove.
              if (gated) {
                return (
                  <li key={item.href}>
                    <span
                      aria-disabled="true"
                      aria-describedby={GATE_HINT_ID}
                      className="inline-block cursor-not-allowed border-b-2 border-transparent px-3 py-2 text-sm text-ink-subtle"
                    >
                      {t(item.key)}
                    </span>
                  </li>
                );
              }

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    // aria-current is what a screen reader announces; the
                    // underline is only its visual echo.
                    aria-current={current ? "page" : undefined}
                    className={`inline-block border-b-2 px-3 py-2 text-sm ${
                      current
                        ? "border-primary font-medium"
                        : "border-transparent text-ink-muted hover:text-ink"
                    }`}
                  >
                    {t(item.key)}
                  </Link>
                </li>
              );
            })}
          </ul>

          {/* The reason, once, referenced by every disabled item above. A
              tooltip would not reach a keyboard or screen-reader user. */}
          {context.awaitingSubscription ? (
            <p id={GATE_HINT_ID} className="mt-2 text-xs text-ink-subtle">
              {t("gatedUntilSubscribed")}
            </p>
          ) : null}
        </nav>
      ) : null}

      {children}
    </div>
  );
}

/* The compatibility surface that lived here through increments 2–7 is gone.
 * `Section`, `Panel`, `Notice`, `NoticeLink`, `ErrorText`, `Field`, `RowLink`,
 * `RowButton` and `useEditPanel` were re-exported from this module so the files
 * importing them could migrate one at a time; the three class-name constants
 * (`inputClass`, `buttonClass`, `secondaryButtonClass`) were redefined in terms
 * of the recipes for the same reason.
 *
 * All 94 call sites now use `components/ui/*` directly, so this file is back to
 * the three things that belong in it: the tenant/permission context, the
 * signed-out redirect, and the shell itself. */
