import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui's Button, adapted to the checklist in phase-11-shadcn-adoption
 * §2.4. Where this file departs from the registry copy, it is for one of these:
 *
 * - **No `outline-none`, no `ring-ring/50`.** A half-opacity ring fails WCAG
 *   1.4.11's 3:1; removing both lets the global `:focus-visible` outline in
 *   globals.css apply, which is contrast-tested in both themes.
 * - **`min-h-11` (44px) at every size**, the touch target this design system
 *   commits to. The registry's `h-9`, `xs` and `icon-sm` sizes are gone.
 * - **`outline` draws its edge with `border-input`** in both themes — that is
 *   `--line-strong`, the 3:1 control boundary. The registry swaps to a tinted
 *   fill in dark mode instead.
 * - **`destructive` uses `text-primary-foreground`**, not `text-white`: the
 *   dark theme's danger is a bright fill that needs near-black text. The pair
 *   is in globals.contrast.test.ts.
 * - **Labels wrap.** No `whitespace-nowrap` — Hungarian labels are long and a
 *   phone is 320px wide.
 *
 * `buttonVariants` is exported for the element that must be neither a
 * `<button>` nor a locale `Link` — `subscription-screen.tsx`'s outbound Stripe
 * link is a plain `<a>` so it bypasses the locale-aware router.
 */
const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-center text-sm font-medium",
    "transition-colors disabled:cursor-not-allowed disabled:opacity-60",
    "aria-invalid:border-destructive",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        destructive: "bg-destructive text-primary-foreground hover:bg-destructive/90",
        outline:
          "border-input bg-background hover:bg-accent hover:text-accent-foreground border shadow-xs",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-11 px-4 py-2 has-[>svg]:px-3",
        sm: "min-h-11 gap-1.5 px-3 py-1.5 has-[>svg]:px-2.5",
        lg: "min-h-12 px-6 has-[>svg]:px-4",
        icon: "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/**
 * `type` defaults to `"button"` rather than the HTML default of `"submit"`:
 * most buttons here sit inside a form and are not its submit action, and an
 * accidental submit is a silent, expensive bug on a booking form.
 *
 * To navigate, use `asChild` around the locale-aware `Link` from
 * `@/i18n/navigation` — never `next/link`, and never a `<button>` that pushes
 * a route. It must render as an anchor: middle-click opens a tab and a screen
 * reader announces "link".
 */
function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  type,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }): React.ReactElement {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      type={asChild ? type : (type ?? "button")}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
