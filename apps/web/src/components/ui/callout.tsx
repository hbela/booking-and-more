import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/cn";

export type CalloutTone = "info" | "action" | "success" | "danger";

/**
 * A prerequisite, a next step, or an outcome. Formerly `Notice`.
 *
 * **`role="note"`, not `role="alert"`.** Nothing has gone wrong — the owner is
 * part-way through setting up and the screen is saying what comes next. An
 * alert interrupts whatever the user is doing, which is right for a failure and
 * wrong for guidance. {@link ./field.tsx}'s `ErrorText` is the other half of
 * that pair.
 *
 * `danger` here is still a note: "this will cancel the booking" is a warning
 * about a thing that has not happened yet. A failure that already happened is
 * an `ErrorText`.
 *
 * Every tone pairs a tinted container with its own text token, each verified at
 * 4.5:1 by globals.contrast.test.ts — so a callout stays legible in both
 * themes, and the tint is never the only thing carrying the meaning.
 */
export function Callout({
  children,
  tone = "info",
  role = "note",
  className,
}: {
  children: React.ReactNode;
  tone?: CalloutTone | undefined;
  /**
   * Overridable, rarely. `alert` is right when the callout appears *in response
   * to something the user just did* and they would otherwise not know it
   * happened — the invitation screen's "you are signed in as somebody else" is
   * the case this exists for. A callout present on first render must stay a
   * `note`, or every page load shouts.
   */
  role?: "note" | "alert" | "status" | undefined;
  className?: string | undefined;
}): React.ReactElement {
  return (
    <div
      role={role}
      className={cn(
        "rounded-xl border px-4 py-3 text-sm",
        {
          info: "border-line bg-surface-raised text-ink",
          action: "border-warning-surface bg-warning-surface text-on-warning-surface",
          success: "border-success-surface bg-success-surface text-on-success-surface",
          danger: "border-danger-surface bg-danger-surface text-on-danger-surface",
        }[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A link inside a {@link Callout}.
 *
 * Underlined rather than colour-only: on a tinted container the link colour
 * alone is not a reliable 3:1 against the surrounding text, and colour is never
 * the sole carrier of meaning here. `currentColor` keeps it legible on every
 * tone without a per-tone link colour.
 */
export function CalloutLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Link href={href} className="font-medium underline underline-offset-2">
      {children}
    </Link>
  );
}
