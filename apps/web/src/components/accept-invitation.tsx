"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";
import { Field } from "./auth-form";

interface InvitationDetails {
  organizationName: string;
  email: string;
  role: string;
  /**
   * The diary a PROVIDER invitation is for; null otherwise. Named on the
   * heading so an invitee notices they were sent the wrong person's link
   * *before* accepting it, which is not something they can undo afterwards
   * (docs/phase-9-provider-onboarding.md §2.6 of the API record).
   */
  providerName: string | null;
  expiresAt: string;
  requiresRegistration: boolean;
}

type State =
  | { kind: "checking" }
  /** No account for the invited address: the owner sets a password here. */
  | { kind: "register"; details: InvitationDetails }
  /** They already have an account, or are signed in as somebody else. */
  | { kind: "needs-sign-in"; details: InvitationDetails | null }
  | { kind: "accepting" }
  | { kind: "accepted"; role: string }
  | { kind: "failed"; message: string };

/**
 * Invitation landing page. docs/phase-9-owner-onboarding.md §4.
 *
 * Three arrivals, one screen:
 *
 *  - **No account yet** — the owner of a newly provisioned organization, which
 *    is every owner in the sales-led flow. They set a password and are done in
 *    one form. Before this existed the page sent them to `/sign-in`, where they
 *    had nothing to sign in with.
 *  - **An account, signed out** — a colleague invited to a second organization.
 *    Sent to sign in, told which address to use.
 *  - **Signed in** — accepted directly, as before.
 *
 * The lookup runs in every case, because the organization's name belongs on the
 * screen before anyone is asked to type a password.
 */
export function AcceptInvitation({ token }: { token: string }): React.ReactElement {
  const t = useTranslations("invitation");
  const router = useRouter();
  const session = useSession();
  const [state, setState] = useState<State>({ kind: "checking" });

  useEffect(() => {
    if (session.isPending) return;
    // Only decide once. Submitting the form updates the session, and without
    // this the effect would re-run and throw away the result.
    if (state.kind !== "checking") return;

    let cancelled = false;

    void apiFetch<InvitationDetails>("/v1/invitations/lookup", {
      method: "POST",
      body: { token },
    })
      .then((details) => {
        if (cancelled) return;

        // Signed in already: the API decides whether the address matches, and
        // says so far better than a client-side guess would.
        if (session.data) {
          setState({ kind: "accepting" });
          return;
        }

        setState(
          details.requiresRegistration
            ? { kind: "register", details }
            : { kind: "needs-sign-in", details },
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          kind: "failed",
          message: error instanceof ApiError ? error.message : t("genericError"),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [session.isPending, session.data, state.kind, token, t]);

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
      <h1 className="text-2xl font-semibold">
        {state.kind !== "register"
          ? t("title")
          : state.details.providerName === null
            ? t("joinTitle", { organization: state.details.organizationName })
            : t("joinTitleAsProvider", {
                organization: state.details.organizationName,
                provider: state.details.providerName,
              })}
      </h1>

      {state.kind === "checking" || state.kind === "accepting" ? <p>{t("working")}</p> : null}

      {state.kind === "register" ? (
        <RegisterForm
          token={token}
          details={state.details}
          onAccepted={(role) => {
            setState({ kind: "accepted", role });
          }}
          onAccountExists={() => {
            // Not a failure state: this is a redirection, and the sign-in panel
            // below already names the address to use.
            setState({ kind: "needs-sign-in", details: state.details });
          }}
        />
      ) : null}

      {state.kind === "needs-sign-in" ? (
        <>
          <p className="text-slate-600 dark:text-slate-400">
            {state.details ? t("signInAs", { email: state.details.email }) : t("signInFirst")}
          </p>
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
              // A provider goes to their own diary, not to the members table.
              // Availability is the one part of this system that is theirs
              // (phase-2-3 §2.7) and the thing the email just asked them to
              // fill in. Everybody else lands where they always did.
              //
              // Still a press rather than an auto-redirect: RegisterForm calls
              // router.refresh() first precisely because the session cookie
              // arrives on a response the cached session does not know about,
              // and navigating on its behalf re-opens that race.
              router.push(state.role === "PROVIDER" ? "/dashboard/availability" : "/dashboard");
            }}
            className="self-start rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white"
          >
            {state.role === "PROVIDER" ? t("goToAvailability") : t("goToDashboard")}
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

/**
 * The one form that replaces four steps.
 *
 * There is no email field: the address comes from the invitation, server-side.
 * Rendering it as an input would suggest it is negotiable, and the API would
 * ignore it anyway (docs/phase-9-owner-onboarding.md §2.1).
 */
function RegisterForm({
  token,
  details,
  onAccepted,
  onAccountExists,
}: {
  token: string;
  details: InvitationDetails;
  onAccepted: (role: string) => void;
  onAccountExists: () => void;
}): React.ReactElement {
  const t = useTranslations("invitation");
  const tAuth = useTranslations("auth");
  const router = useRouter();

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const result = await apiFetch<{ tenantId: string; role: string }>(
        "/v1/invitations/accept-and-register",
        { method: "POST", body: { token, name, password } },
      );

      // The API set a session cookie on this response, but the cached session
      // does not know it. Refresh before navigating, or /dashboard renders as
      // signed out and bounces straight back.
      router.refresh();
      onAccepted(result.role);
    } catch (error_: unknown) {
      if (error_ instanceof ApiError) {
        // Someone registered this address between the lookup and the submit —
        // rare, but it is exactly the race the server-side check exists for.
        if (error_.status === 409) {
          onAccountExists();
          return;
        }
        setError(error_.message);
        return;
      }
      setError(tAuth("networkError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <p className="text-slate-600 dark:text-slate-400">
        {t("settingUpFor", { email: details.email })}
      </p>

      <form
        onSubmit={(event) => {
          void onSubmit(event);
        }}
        className="flex flex-col gap-4"
        noValidate
      >
        <Field
          id="name"
          label={tAuth("name")}
          type="text"
          value={name}
          onChange={setName}
          autoComplete="name"
          required
        />

        <Field
          id="password"
          label={tAuth("password")}
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          required
          minLength={12}
          hint={tAuth("passwordHint")}
        />

        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-brand-600 px-4 py-2 font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
        >
          {pending ? tAuth("working") : t("createAccount")}
        </button>
      </form>
    </>
  );
}
