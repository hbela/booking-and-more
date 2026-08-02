"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { apiFetch, type MeResponse } from "@/lib/api-client";
import { signOut } from "@/lib/auth-client";
import { LocaleSwitcher } from "./locale-switcher";

/**
 * Language, and the way in or out. Shared by the site root and the admin
 * section, which is why the sign-out destination is a prop rather than a
 * constant: signing out of `/admin` returns to `/admin`, while the root returns
 * to the root. The tenant dashboard keeps its own button and still lands on
 * `/sign-in` — three destinations, one component, no `if (pathname…)`.
 *
 * The session is read through the same `["me"]` query key the dashboard and the
 * platform screen use, so all three share one cache entry and one request
 * rather than each asking who is signed in.
 */
export function AuthHeader({ signOutTo }: { signOutTo: string }): React.ReactElement {
  const t = useTranslations("common");
  const auth = useTranslations("auth");
  const dashboard = useTranslations("dashboard");
  const router = useRouter();
  const queryClient = useQueryClient();

  // `retry: false` because 401 is the ordinary signed-out answer, not a
  // failure worth three attempts.
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<MeResponse>("/v1/me"),
    retry: false,
  });

  const controlClass =
    "rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700";

  return (
    <div className="flex flex-wrap items-end gap-3">
      <LocaleSwitcher label={t("language")} />

      {/* Nothing is rendered until the session is known: a Sign in button that
          flips to Sign out a moment later invites a click on whichever one the
          reader was aiming at. */}
      {me.isPending ? null : me.data ? (
        <button
          type="button"
          onClick={() => {
            void signOut().then(() => {
              // Clear rather than invalidate: every cached query was answered
              // for the person who just left.
              queryClient.clear();
              router.push(signOutTo);
            });
          }}
          className={controlClass}
        >
          {dashboard("signOut")}
        </button>
      ) : (
        <Link href="/sign-in" className={controlClass}>
          {auth("signIn")}
        </Link>
      )}
    </div>
  );
}
