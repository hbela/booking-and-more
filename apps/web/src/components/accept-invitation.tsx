"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";

type State =
  | { kind: "checking" }
  | { kind: "needs-sign-in" }
  | { kind: "accepting" }
  | { kind: "accepted"; role: string }
  | { kind: "failed"; message: string };

/**
 * Invitation landing page.
 *
 * The token arrives in the URL, so the flow has to handle the common case of
 * someone opening the link while signed out — or signed in as the wrong person.
 * The API refuses a mismatched account; this surfaces that rather than failing
 * opaquely.
 */
export function AcceptInvitation({ token }: { token: string }): React.ReactElement {
  const t = useTranslations("invitation");
  const router = useRouter();
  const session = useSession();
  const [state, setState] = useState<State>({ kind: "checking" });

  useEffect(() => {
    if (session.isPending) return;

    if (!session.data) {
      setState({ kind: "needs-sign-in" });
      return;
    }

    // Run once per token, not on every render.
    setState((current) => (current.kind === "checking" ? { kind: "accepting" } : current));
  }, [session.isPending, session.data]);

  useEffect(() => {
    if (state.kind !== "accepting") return;

    void apiFetch<{ tenantId: string; role: string }>("/v1/invitations/accept", {
      method: "POST",
      body: { token },
    })
      .then((result) => {
        setState({ kind: "accepted", role: result.role });
      })
      .catch((error: unknown) => {
        setState({
          kind: "failed",
          message: error instanceof ApiError ? error.message : t("genericError"),
        });
      });
  }, [state.kind, token, t]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 px-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>

      {state.kind === "checking" || state.kind === "accepting" ? <p>{t("working")}</p> : null}

      {state.kind === "needs-sign-in" ? (
        <>
          <p className="text-slate-600 dark:text-slate-400">{t("signInFirst")}</p>
          <button
            type="button"
            onClick={() => {
              router.push("/sign-in");
            }}
            className="self-start rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white"
          >
            {t("goToSignIn")}
          </button>
        </>
      ) : null}

      {state.kind === "accepted" ? (
        <>
          <p role="status">{t("accepted", { role: state.role })}</p>
          <button
            type="button"
            onClick={() => {
              router.push("/dashboard");
            }}
            className="self-start rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white"
          >
            {t("goToDashboard")}
          </button>
        </>
      ) : null}

      {state.kind === "failed" ? (
        <p role="alert" className="text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}
    </main>
  );
}
