"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * `alwaysAvailable` marks the two destinations that survive the activation gate
 * (phase-9 §2.11): the overview, which explains the situation, and the
 * subscription screen, which resolves it. Everything else needs a tenant that
 * accepts writes.
 *
 * `permissions` is **any one of these**, and a caller holding none of them does
 * not see the item at all. That is deliberately the opposite of the activation
 * gate below, which disables and explains: that gate is temporary and the user
 * can resolve it, so naming the reason is useful. A permission somebody will
 * never hold is not actionable, and an item announcing it on every page load is
 * noise (docs/phase-9-provider-onboarding.md §2.9).
 *
 * Advisory, like every other affordance here — the API re-authorises each
 * request, so hiding an item has never been what stops anything. The literals
 * are strings rather than `Permissions.*` because `@bam/auth` is not a
 * dependency of this app and every other call site spells them out too; the
 * risk that a typo silently hides an item is recorded in that record's §7.
 */
const NAV = [
  // Ungated on purpose. It is the only screen guaranteed reachable —
  // `landingFor()` sends everyone here, and so does the sign-in redirect — so
  // an unreachable current page would be a worse failure than a spare item.
  { href: "/dashboard", key: "overview" as const, alwaysAvailable: true, permissions: null },
  {
    href: "/dashboard/subscription",
    key: "subscription" as const,
    alwaysAvailable: true,
    permissions: ["billing:manage"],
  },
  // Bookings sit first among the gated items, ahead of the catalogue: the
  // catalogue is configured once and the diary is looked at every day.
  // Both scopes: a provider's own bookings are the point of the role, and
  // bookings-screen.tsx already copes — it gates only its provider filter on
  // `booking:read:all` and lets the server scope the list.
  {
    href: "/dashboard/bookings",
    key: "bookings" as const,
    alwaysAvailable: false,
    permissions: ["booking:read:all", "booking:read:own"],
  },
  // The catalogue then runs in the order it has to be built, which is not the
  // order it was written in. A provider is booked *for a service*, so a provider
  // created first has nothing to offer and cannot appear on the booking page;
  // availability comes last because it needs a provider to belong to. Locations
  // sit next to services because both stand alone — neither needs anything else
  // to exist first.
  {
    href: "/dashboard/services",
    key: "services" as const,
    alwaysAvailable: false,
    permissions: ["service:manage"],
  },
  {
    href: "/dashboard/locations",
    key: "locations" as const,
    alwaysAvailable: false,
    permissions: ["location:manage"],
  },
  {
    href: "/dashboard/providers",
    key: "providers" as const,
    alwaysAvailable: false,
    permissions: ["provider:manage"],
  },
  // Availability is deliberately absent. It belongs to a provider, not to the
  // organization: an owner reaches one diary at a time from the row on
  // Providers, and a member who *is* a provider gets the item back below,
  // pointing at their own. A top-level entry implied the owner fills it in,
  // which is the opposite of who decides (phase-2-3 §2.7).
];

/** Appended for a member whose membership names a provider — their own diary. */
const OWN_DIARY = {
  href: "/dashboard/availability",
  key: "availability" as const,
  alwaysAvailable: false,
  // Already gated by `membership.providerId`, which is stricter than any
  // permission: `availability:manage:own` without a linked diary matches
  // nothing at all.
  permissions: null,
};

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

      {/* `!isPending` is not belt and braces: `tenantId` can resolve from the
          tenants query before `me` lands, and `can()` answers false until then —
          so without it the nav paints with one item and then grows, moving the
          target somebody is already reaching for. */}
      {context.tenantId && !context.isPending ? (
        <nav aria-label={t("sections")}>
          <ul className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
            {(context.me?.membership?.providerId ? [...NAV, OWN_DIARY] : NAV)
              .filter(
                (item) =>
                  item.permissions === null ||
                  item.permissions.some((permission) => context.can(permission)),
              )
              .map((item) => {
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
                        className="inline-block cursor-not-allowed border-b-2 border-transparent px-3 py-2 text-sm text-slate-400 dark:text-slate-600"
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

          {/* The reason, once, referenced by every disabled item above. A
              tooltip would not reach a keyboard or screen-reader user. */}
          {context.awaitingSubscription ? (
            <p id={GATE_HINT_ID} className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {t("gatedUntilSubscribed")}
            </p>
          ) : null}
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

/**
 * A form panel with a heading.
 *
 * Takes the rest of a `<section>`'s props so {@link useEditPanel}'s
 * `panelProps` can be spread onto it — that is how an editing panel becomes
 * focusable and addressable by the row button's `aria-controls`.
 */
export function Panel({
  title,
  children,
  ...rest
}: {
  title: string;
  children: React.ReactNode;
} & Omit<React.ComponentPropsWithRef<"section">, "title" | "children">): React.ReactElement {
  return (
    // No `focus:outline-none` here: when the panel takes focus programmatically
    // the ring from globals.css is the only thing telling the user where they
    // landed.
    <section
      className="flex flex-col gap-4 rounded-xl border border-slate-200 p-5 dark:border-slate-800"
      {...rest}
    >
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * A prerequisite or next-step message.
 *
 * Not an `ErrorText`: nothing has gone wrong, the owner is simply part-way
 * through setting up and the screen can say what comes next. `role="note"` and
 * not `role="alert"`, so it is available to a screen reader without interrupting
 * whatever the user is doing.
 */
export function Notice({
  children,
  tone = "info",
}: {
  children: React.ReactNode;
  /** `action` when something must be done before this screen is useful. */
  tone?: "info" | "action";
}): React.ReactElement {
  const palette =
    tone === "action"
      ? "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30"
      : "border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40";

  return (
    <p role="note" className={`rounded-lg border px-4 py-3 text-sm ${palette}`}>
      {children}
    </p>
  );
}

/** An inline link out to another dashboard screen, for use inside a {@link Notice}. */
export function NoticeLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Link href={href} className="font-medium text-brand-600 underline dark:text-brand-500">
      {children}
    </Link>
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

/** The quieter sibling of {@link buttonClass}: cancel, back out, dismiss. */
export const secondaryButtonClass =
  "rounded-md border border-slate-300 px-4 py-2 text-sm dark:border-slate-700";

/** A compact action inside a table row. */
/**
 * A row action that navigates rather than acting. Styled as {@link RowButton}
 * because it sits in the same group, but it is an anchor: it opens in a new tab
 * on middle-click, and a screen reader announces it as a link.
 */
export function RowLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Link
      href={href}
      className="rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700"
    >
      {children}
    </Link>
  );
}

export function RowButton({
  onClick,
  children,
  ...rest
}: {
  onClick: () => void;
  children: React.ReactNode;
} & Omit<React.ComponentPropsWithRef<"button">, "onClick" | "children">): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700"
      {...rest}
    >
      {children}
    </button>
  );
}

export interface EditPanel {
  /** The row currently open, or null. */
  openId: string | null;
  /** Open this row, or close it if it is already open. */
  toggle: (id: string) => void;
  close: () => void;
  /** Spread onto the panel element so focus and labelling work. */
  panelProps: { id: string; ref: React.RefObject<HTMLElement | null>; tabIndex: -1 };
  /** Spread onto the row's trigger button. */
  triggerProps: (id: string) => { "aria-expanded": boolean; "aria-controls": string };
}

/**
 * One open editing panel per screen, with the focus wiring a dialog would give
 * us for free.
 *
 * There is no Dialog primitive here and there is not going to be one — the
 * screens use an inline `Panel` toggled by state. What that pattern loses is
 * everything a dialog does about focus: before this hook, pressing "Assign"
 * rendered a panel below the fold and left the caret on the button, so for a
 * keyboard or screen-reader user *nothing observable happened*. So the panel
 * takes focus on open and hands it back on close, and the trigger announces
 * what it controls.
 *
 * `scrollIntoView` uses `block: "nearest"`, which does nothing when the panel is
 * already visible — the common case on a short list, where scrolling would be
 * an unexplained jump.
 */
export function useEditPanel(name: string): EditPanel {
  const [openId, setOpenId] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelId = `${name}-edit-panel`;

  // After the panel mounts, not during the click that opened it.
  useEffect(() => {
    if (openId === null) return;

    panelRef.current?.focus();
    panelRef.current?.scrollIntoView({ block: "nearest" });
  }, [openId]);

  const close = useCallback(() => {
    setOpenId(null);
    // Focus would otherwise fall back to <body>, stranding a keyboard user at
    // the top of the document with no idea where they were.
    triggerRef.current?.focus();
  }, []);

  const toggle = useCallback((id: string) => {
    setOpenId((current) => (current === id ? null : id));
    triggerRef.current = document.activeElement as HTMLElement | null;
  }, []);

  const triggerProps = useCallback(
    (id: string) => ({ "aria-expanded": openId === id, "aria-controls": panelId }),
    [openId, panelId],
  );

  return {
    openId,
    toggle,
    close,
    panelProps: { id: panelId, ref: panelRef, tabIndex: -1 },
    triggerProps,
  };
}
