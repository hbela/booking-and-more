import { cn } from "@/lib/cn";

/**
 * A bordered panel with a heading. Formerly `Panel` in `dashboard-shell.tsx`.
 *
 * It takes the rest of a `<section>`'s props so `useEditPanel`'s `panelProps`
 * can be spread onto it — that is how an editing panel becomes focusable and
 * addressable by its row button's `aria-controls`. **That contract must
 * survive**: `id`, `ref` and `tabIndex={-1}` all have to reach the DOM node.
 *
 * There is deliberately no `focus:outline-none` here. When the panel takes
 * focus programmatically, the ring from globals.css is the only thing telling
 * the user where they landed — and there is no Dialog primitive in this app to
 * do it for them (see the note on `useEditPanel`).
 */
export function Card({
  title,
  description,
  actions,
  children,
  className,
  ...rest
}: {
  title?: string | undefined;
  description?: string | undefined;
  /** Buttons that belong to the panel as a whole, aligned with its heading. */
  actions?: React.ReactNode | undefined;
  children: React.ReactNode;
} & Omit<React.ComponentPropsWithRef<"section">, "title" | "children">): React.ReactElement {
  return (
    <section
      className={cn("border-line bg-surface flex flex-col gap-4 rounded-xl border p-6", className)}
      {...rest}
    >
      {title === undefined && actions === undefined ? null : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            {title === undefined ? null : (
              <h2 className="font-display text-ink text-lg font-semibold">{title}</h2>
            )}
            {description === undefined ? null : (
              <p className="text-ink-muted text-sm">{description}</p>
            )}
          </div>
          {actions}
        </div>
      )}

      {children}
    </section>
  );
}
