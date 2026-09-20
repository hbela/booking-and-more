"use client";

import { useState } from "react";
import { useLocale } from "next-intl";
import { authClient, useSession } from "@/lib/auth-client";

export function VerifyEmailBanner() {
  const { data } = useSession();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const hu = useLocale() === "hu";
  if (!data?.user || data.user.emailVerified) return null;
  return (
    <aside
      className="rounded-xl border border-line p-4"
      aria-label={hu ? "E-mail ellenőrzés" : "Email verification"}
    >
      <p>
        {hu
          ? "A szervezet létrehozása és az előfizetés előtt erősítse meg e-mail-címét. Az induláskor csak meghívott vállalkozások csatlakozhatnak."
          : "Verify your email before creating an organization or starting checkout. Business onboarding is currently invitation-only."}
      </p>
      <button
        type="button"
        disabled={busy}
        className="mt-2 underline disabled:opacity-50"
        onClick={() => {
          void (async () => {
            setBusy(true);
            try {
              const result = await authClient.sendVerificationEmail({
                email: data.user.email,
                callbackURL: window.location.href,
              });
              setMessage(
                result.error
                  ? hu
                    ? "A küldés sikertelen. Próbálja újra."
                    : "Could not send verification. Please retry."
                  : hu
                    ? "Ellenőrizze postaládáját."
                    : "Check your inbox for the verification link.",
              );
            } catch {
              setMessage(
                hu
                  ? "A küldés sikertelen. Próbálja újra."
                  : "Could not send verification. Please retry.",
              );
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        {hu ? "Megerősítő e-mail újraküldése" : "Resend verification email"}
      </button>
      <p role="status">{message}</p>
    </aside>
  );
}
