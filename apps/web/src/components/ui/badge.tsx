import { cn } from "@/lib/cn";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

/**
 * A status chip: booking states, subscription states, invitation states.
 *
 * **The word is the status; the colour only agrees with it.** Every call site
 * passes real text — never an empty coloured dot — because colour alone fails
 * WCAG 1.4.1 and is invisible to roughly one man in twelve. The tone/text
 * pairings are contrast-checked in globals.contrast.test.ts.
 *
 * Not a `<span role="status">`: these render in tables and lists as static
 * labels, and a live region would announce every row on every re-render.
 */
export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        {
          neutral: "bg-surface-sunken text-ink-muted",
          info: "bg-primary-surface text-on-primary-surface",
          success: "bg-success-surface text-on-success-surface",
          warning: "bg-warning-surface text-on-warning-surface",
          danger: "bg-danger-surface text-on-danger-surface",
        }[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
