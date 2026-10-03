import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui's Badge — a status chip: booking, subscription, invitation and
 * integration states.
 *
 * **The word is the status; the colour only agrees with it.** Every call site
 * passes real text — never an empty coloured dot — because colour alone fails
 * WCAG 1.4.1. Not a `<span role="status">`: these render in tables and lists as
 * static labels, and a live region would announce every row on every render.
 *
 * Departures from the registry copy (phase-11-shadcn-adoption §3.6):
 *
 * - **`success`, `warning` and `info` are added**, carried over from the
 *   phase-11 Badge's tones; the registry has no way to say "confirmed".
 * - **`destructive` is a tinted chip, not a filled one.** The registry fills it
 *   with `--destructive` and white text, which fails in the dark theme, where
 *   danger is a bright fill. Every tinted variant uses a surface/text pair that
 *   globals.contrast.test.ts asserts at 4.5:1.
 * - No `focus-visible:ring-ring/50` (§2.4).
 */
const badgeVariants = cva(
  [
    "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent",
    "px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors",
    "[&>svg]:pointer-events-none [&>svg]:size-3",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary-hover",
        secondary: "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive: "bg-danger-surface text-on-danger-surface",
        success: "bg-success-surface text-on-success-surface",
        warning: "bg-warning-surface text-on-warning-surface",
        info: "bg-primary-surface text-on-primary-surface",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }): React.ReactElement {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants, type BadgeVariant };
