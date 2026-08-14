import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

/**
 * Shared button styling, exposed as a function rather than only as a component.
 *
 * The recipe carried the migration: `dashboard-shell.tsx`'s deprecated
 * `buttonClass` / `secondaryButtonClass` constants were defined in terms of it
 * so their fourteen importers could move one at a time. Those are gone now, and
 * the recipe stays for the case components cannot cover — an element that must
 * not be a `<button>` or a `ButtonLink`. `subscription-screen.tsx` uses it for
 * the outbound Stripe link, which has to be a plain `<a>` so it bypasses the
 * locale-aware router.
 *
 * `min-h-11` is 44px, the minimum touch target this design system commits to.
 */
export function buttonRecipe({
  variant = "primary",
  size = "md",
}: { variant?: ButtonVariant | undefined; size?: ButtonSize | undefined } = {}): string {
  return cn(
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg font-medium",
    "transition-colors disabled:cursor-not-allowed disabled:opacity-60",
    size === "sm" ? "px-3 py-1.5 text-sm" : "px-4 py-2 text-sm",
    {
      // The dark theme inverts this to a bright fill with near-black text
      // rather than dimming — see globals.css. Nothing to do here: both sides
      // come from --primary / --on-primary.
      primary: "bg-primary text-on-primary hover:bg-primary-hover",
      secondary: "border-line-strong text-ink hover:bg-surface-raised border bg-transparent",
      ghost: "text-primary hover:bg-primary-surface bg-transparent",
      danger: "bg-danger text-on-primary hover:opacity-90",
    }[variant],
  );
}

export function Button({
  variant,
  size,
  className,
  type = "button",
  ...rest
}: {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
} & React.ComponentPropsWithRef<"button">): React.ReactElement {
  // `type` defaults to "button" rather than the HTML default of "submit": most
  // buttons here sit inside a form and are not its submit action, and an
  // accidental submit is a silent, expensive bug on a booking form.
  return <button type={type} className={cn(buttonRecipe({ variant, size }), className)} {...rest} />;
}

/**
 * A button-shaped link.
 *
 * Separate from {@link Button} on purpose: it navigates, so it must be an
 * anchor — middle-click opens a tab, and a screen reader announces "link", not
 * "button". This repo already refuses the inverse mistake (a disabled anchor
 * painted to look inert, which still activates on Enter), and the same care
 * applies in this direction.
 *
 * `href` goes through the locale-aware `Link` from `@/i18n/navigation`, never
 * `next/link`.
 */
export function ButtonLink({
  variant,
  size,
  className,
  ...rest
}: {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
} & React.ComponentPropsWithoutRef<typeof Link>): React.ReactElement {
  return <Link className={cn(buttonRecipe({ variant, size }), className)} {...rest} />;
}
