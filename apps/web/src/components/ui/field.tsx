import { cn } from "@/lib/cn";
import { Input } from "./input";

/**
 * A labelled control.
 *
 * **Deliberately the same name and props as the `Field` that lived in
 * `dashboard-shell.tsx`**, so the six `*-fields.tsx` files that use it need an
 * import path change and nothing else. The label wraps the control, so the
 * association holds even if somebody forgets to match `htmlFor` to `id`.
 *
 * There were two incompatible `Field`s in the app: this one, which takes the
 * control as children, and one in `auth-form.tsx` that rendered its own input.
 * They were never in conflict — they are two different components. This is
 * `Field`; the other is {@link TextField} below.
 */
export function Field({
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
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-ink text-sm font-medium">
        {label}
      </label>

      {/* Nothing is cloned or injected — the caller passes a real element and
          sets its own `id`, which keeps this out of the way of a `<select>`, a
          checkbox group, or a control with its own state.
          The trade is that a caller using `hint`/`error` must point the control
          at `{id}-hint` / `{id}-error` with `aria-describedby` itself.
          {@link TextField} does that wiring; use it whenever the control is a
          plain input, which is most of the time. */}
      {children}

      {error ? (
        <p id={`${id}-error`} role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-ink-muted text-sm">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Label plus input in one, i.e. what `auth-form.tsx` called `Field`.
 *
 * For the common case where the control is a plain text input and there is
 * nothing to configure. Anything else — a select, a checkbox, a group, a
 * control with its own state — uses {@link Field} and passes the control in.
 */
export function TextField({
  id,
  label,
  hint,
  error,
  className,
  ...rest
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
} & Omit<React.ComponentPropsWithRef<"input">, "id">): React.ReactElement {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cn(error && "border-danger", className)}
        {...rest}
      />
    </Field>
  );
}

/**
 * An error that is not attached to a field.
 *
 * `role="alert"` so it interrupts — this is the "something went wrong" case,
 * unlike {@link ./callout.tsx}'s `role="note"`, which is "here is what to do
 * next" and must not. Returns null when empty so callers can pass a possibly
 * absent message without guarding.
 */
export function ErrorText({ children }: { children: React.ReactNode }): React.ReactElement | null {
  if (!children) return null;

  return (
    <p role="alert" className="text-danger text-sm">
      {children}
    </p>
  );
}
