import { Field, FieldDescription, FieldError, FieldLabel } from "./field";
import { Input } from "./input";

/**
 * A labelled control, composed from shadcn's `Field` parts.
 *
 * shadcn's `Field` is a bare container you fill with `FieldLabel`,
 * `FieldDescription` and `FieldError`. This is the one-line form of that
 * composition the app uses 60-odd times, so the `aria-describedby` targets are
 * spelled in one place rather than at every call site
 * (phase-11-shadcn-adoption §3.3). Anything needing a different layout — a
 * checkbox row, a fieldset — composes the `./field` parts directly.
 *
 * Nothing is cloned or injected — the caller passes a real element and sets its
 * own `id`, which keeps this out of the way of a `<select>`, a checkbox group,
 * or a control with its own state. The trade is that a caller using
 * `hint`/`error` must point the control at `{id}-hint` / `{id}-error` with
 * `aria-describedby` itself. {@link TextField} does that wiring; use it
 * whenever the control is a plain input.
 */
export function FormField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  /** Guidance shown before anything goes wrong. */
  hint?: string | undefined;
  /** Shown instead of the hint once it does. */
  error?: string | undefined;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Field data-invalid={error ? true : undefined} className="gap-1.5">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children}
      {error ? (
        <FieldError id={`${id}-error`}>{error}</FieldError>
      ) : hint ? (
        <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
      ) : null}
    </Field>
  );
}

/**
 * Label plus input in one — for the common case where the control is a plain
 * text input and there is nothing to configure. Anything else uses
 * {@link FormField} and passes the control in.
 */
export function TextField({
  id,
  label,
  hint,
  error,
  ...rest
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
} & Omit<React.ComponentPropsWithRef<"input">, "id">): React.ReactElement {
  return (
    <FormField id={id} label={label} hint={hint} error={error}>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        {...rest}
      />
    </FormField>
  );
}

/**
 * An error that is not attached to a field.
 *
 * `role="alert"` so it interrupts — this is the "something went wrong" case,
 * unlike {@link ./alert.tsx}'s `role="note"`, which is "here is what to do
 * next" and must not. Returns null when empty so callers can pass a possibly
 * absent message without guarding.
 */
export function ErrorText({ children }: { children: React.ReactNode }): React.ReactElement | null {
  if (!children) return null;

  return (
    <p role="alert" className="text-destructive text-sm">
      {children}
    </p>
  );
}
