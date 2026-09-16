"use client";

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { ApiError, apiFetch } from "@/lib/api-client";
import { signOut } from "@/lib/auth-client";
import { enterTenant, TenantLoginDenied } from "@/lib/tenant-login";
import { AuthForm } from "./auth-form";
import { Button } from "./ui/button";

export function TenantSignIn({ tenantSlug }: { tenantSlug: string }): React.ReactElement {
  const t = useTranslations("tenantLogin");
  const router = useRouter();
  const client = useQueryClient();
  const [phase, setPhase] = useState<"checking" | "form" | "entering" | "error">("checking");
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const enter = useCallback(
    async (isActive: () => boolean = () => true) => {
      try {
        const target = await enterTenant(tenantSlug);
        if (!isActive()) return;
        await client.cancelQueries();
        client.clear();
        router.replace(target);
        router.refresh();
      } catch (cause) {
        if (!isActive()) return;
        setError(t(cause instanceof TenantLoginDenied ? "noMembership" : "failed"));
        setPhase("error");
      }
    },
    [client, router, t, tenantSlug],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await apiFetch("/v1/me");
        if (active) await enter(() => active);
      } catch (cause) {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 401) setPhase("form");
        else {
          setError(t("failed"));
          setPhase("error");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [enter, t]);

  if (phase === "checking" || phase === "entering") return <p role="status">{t("checking")}</p>;
  if (phase === "form")
    return (
      <AuthForm
        mode="sign-in"
        onAuthenticated={async () => {
          setPhase("entering");
          await enter();
        }}
      />
    );

  return (
    <div className="grid gap-4">
      <p role="alert" className="text-danger">
        {error}
      </p>
      <Button
        disabled={signingOut}
        onClick={() => {
          setSigningOut(true);
          void (async () => {
            try {
              const result = await signOut();
              if (result.error) throw new Error("Sign-out failed");
              await client.cancelQueries();
              client.clear();
              setError(null);
              setPhase("form");
            } catch {
              setError(t("failed"));
            } finally {
              setSigningOut(false);
            }
          })();
        }}
      >
        {t("useAnotherAccount")}
      </Button>
    </div>
  );
}
