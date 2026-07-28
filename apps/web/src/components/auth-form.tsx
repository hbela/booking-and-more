"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { signIn, signUp } from "@/lib/auth-client";

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

      router.push("/dashboard");
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

      {error ? (
        // role="alert" so a screen reader announces the failure rather than
        // leaving the user wondering why nothing happened (PRD §12.4).
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-brand-600 px-4 py-2 font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
      >
        {pending ? t("working") : mode === "sign-up" ? t("createAccount") : t("signIn")}
      </button>
    </form>
  );
}

function Field({
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
  required?: boolean;
  minLength?: number;
  hint?: string | undefined;
}): React.ReactElement {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="rounded-md border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700"
      />
      {hint ? (
        <span id={`${id}-hint`} className="text-xs text-slate-500 dark:text-slate-400">
          {hint}
        </span>
      ) : null}
    </label>
  );
}
