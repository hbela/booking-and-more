import { cva, type VariantProps } from "class-variance-authority";

import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui's Alert, which replaces the phase-11 `Callout`: a prerequisite, a
 * next step, or an outcome.
 *
 * **`role="note"` by default, not the registry's `role="alert"`.** Nothing has
 * gone wrong — the owner is part-way through setting up and the screen is
 * saying what comes next. An alert interrupts whatever the user is doing,
 * which is right for a failure and wrong for guidance; a callout present on
 * first render that announced itself would make every page load shout.
 * Override it rarely: `alert` when the box appears *in response to something
 * the user just did* and they would otherwise not know (the invitation
 * screen's "you are signed in as somebody else"), `status` for a quiet outcome.
 * {@link ./form-field.tsx}'s `ErrorText` is the failure half of the pair.
 *
 * `destructive` here is still a note: "this will cancel the booking" warns
 * about something that has not happened yet.
 *
 * Departures from the registry copy (phase-11-shadcn-adoption §3.6):
 *
 * - **Tinted tones** — `warning` and `success` are added, `destructive` is a
 *   tinted container, and `default` is the raised surface. Each pairs a
 *   container with its own text token, all asserted by
 *   globals.contrast.test.ts, so the tint is never the only carrier of meaning.
 * - **`AlertDescription` is a block that inherits the tone's colour.** The
 *   registry's is a grid in `text-muted-foreground`: a grid splits a sentence
 *   that contains an inline link into separate lines, and muted text on a
 *   tinted container is an untested contrast pair.
 * - `AlertTitle` does not `line-clamp-1` — a truncated Hungarian heading is
 *   unreadable, not tidy.
 */
const alertVariants = cva(
  [
    "relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border px-4 py-3 text-sm",
    "has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3",
    "[&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  ],
  {
    variants: {
      variant: {
        default: "border-border bg-surface-raised text-foreground",
        warning: "border-warning-surface bg-warning-surface text-on-warning-surface",
        success: "border-success-surface bg-success-surface text-on-success-surface",
        destructive: "border-danger-surface bg-danger-surface text-on-danger-surface",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Alert({
  className,
  variant,
  role = "note",
  ...props
}: Omit<React.ComponentProps<"div">, "role"> &
  VariantProps<typeof alertVariants> & {
    role?: "note" | "alert" | "status";
  }): React.ReactElement {
  return (
    <div
      data-slot="alert"
      role={role}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      data-slot="alert-title"
      className={cn("col-start-2 min-h-4 font-medium tracking-tight", className)}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      data-slot="alert-description"
      className={cn("col-start-2 text-sm [&_p]:leading-relaxed", className)}
      {...props}
    />
  );
}

/**
 * A link inside an {@link Alert}, formerly `CalloutLink`.
 *
 * Underlined rather than colour-only: on a tinted container a link colour is
 * not a reliable 3:1 against the surrounding text. `currentColor` keeps it
 * legible on every tone without a per-tone link colour.
 */
function AlertLink({
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

export { Alert, AlertDescription, AlertLink, AlertTitle };
