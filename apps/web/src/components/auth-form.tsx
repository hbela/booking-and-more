"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { apiFetch, type MeResponse } from "@/lib/api-client";
import { signIn, signUp } from "@/lib/auth-client";
import { Button } from "./ui/button";
import { ErrorText, TextField } from "./ui/field";

/**
 * Where a freshly signed-in person belongs.
 *
 * A platform admin holds no memberships by design (CLAUDE.md rule 9), so
 * `/dashboard` can only tell them they are in the wrong place — it has nothing
 * else to show. They go to `/admin` instead.
 *
 * A failure here must not strand somebody who *did* authenticate successfully,
 * so an unreadable `/v1/me` falls back to `/dashboard`, which is exactly where
 * everyone went before this existed.
 */
async function landingFor(): Promise<string> {
  const me = await apiFetch<MeResponse>("/v1/me").catch(() => null);

  return me?.user.isPlatformAdmin === true ? "/admin" : "/dashboard";
}

/**
 * Sign-in and sign-up, sharing one form because the fields differ by exactly
 * one input.
 *
 * Server-side rules are not duplicated here beyond `minLength`: the API is the
 * authority on password policy, and a second copy in the client would drift.
 */
export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }): React.ReactElement {
  const t = useTranslations("auth");
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const result =
        mode === "sign-up"
          ? await signUp.email({ email, password, name })
          : await signIn.email({ email, password });

      if (result.error) {
        setError(result.error.message ?? t("genericError"));
        return;
      }

      router.push(mode === "sign-up" ? "/dashboard" : await landingFor());
      router.refresh();
    } catch {
      // Network-level failure — the API never answered.
      setError(t("networkError"));
    } finally {
      setPending(false);
    }
  }

  return (
    // `void` because onSubmit is async and the DOM handler expects void; the
    // promise is fully handled inside (including its catch), so nothing is lost.
    <form
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex flex-col gap-4"
      noValidate
    >
      {mode === "sign-up" ? (
        <Field
          id="name"
          label={t("name")}
          type="text"
          value={name}
          onChange={setName}
          autoComplete="name"
          required
        />
      ) : null}

      <Field
        id="email"
        label={t("email")}
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        required
      />

      <Field
        id="password"
        label={t("password")}
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
        required
        minLength={12}
        hint={mode === "sign-up" ? t("passwordHint") : undefined}
      />

      {/* role="alert" so a screen reader announces the failure rather than
          leaving the user wondering why nothing happened (PRD §12.4). */}
      <ErrorText>{error}</ErrorText>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? t("working") : mode === "sign-up" ? t("createAccount") : t("signIn")}
      </Button>
    </form>
  );
}

/**
 * Exported so the invitation flow renders identical inputs rather than a second
 * set that drifts — it is the same act (choosing a password) on a different
 * screen. See accept-invitation.tsx.
 *
 * This is now a thin adapter over {@link TextField}: it keeps the
 * `onChange: (value: string) => void` signature its two callers already use,
 * rather than making them each unwrap an event. The styling and the
 * hint/`aria-describedby` wiring come from the shared primitive.
 *
 * It kept the name `Field` deliberately. There were two components called that
 * — this one, which owns its input, and `dashboard-shell.tsx`'s, which wraps an
 * arbitrary control. They were never in conflict; they are `TextField` and
 * `Field` in `components/ui`, and this local name survives only until its two
 * callers move over.
 */
export function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  required,
  minLength,
  hint,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  required?: boolean | undefined;
  minLength?: number | undefined;
  hint?: string | undefined;
}): React.ReactElement {
  return (
    <TextField
      id={id}
      label={label}
      type={type}
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      autoComplete={autoComplete}
      required={required}
      minLength={minLength}
      hint={hint}
    />
  );
}
