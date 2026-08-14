import { cn } from "@/lib/cn";

/**
 * Shared control styling.
 *
 * `border-line-strong` and not `border-line`: this border *is* the boundary of
 * a control, which WCAG 1.4.11 requires to reach 3:1 against the surface behind
 * it. The two border tokens exist for exactly this distinction — see the note
 * in globals.css.
 *
 * `bg-surface` rather than `bg-transparent` (which is what the old `inputClass`
 * used) so a field sitting on a raised card still reads as a field.
 */
export function inputRecipe(): string {
  return cn(
    "border-line-strong bg-surface text-ink placeholder:text-ink-subtle",
    "min-h-11 w-full rounded-lg border px-3 py-2 text-base",
    "disabled:cursor-not-allowed disabled:opacity-60",
  );
}

export function Input({
  className,
  ...rest
}: React.ComponentPropsWithRef<"input">): React.ReactElement {
  return <input className={cn(inputRecipe(), className)} {...rest} />;
}

export function Textarea({
  className,
  ...rest
}: React.ComponentPropsWithRef<"textarea">): React.ReactElement {
  return <textarea className={cn(inputRecipe(), "min-h-24 resize-y", className)} {...rest} />;
}

/**
 * A native `<select>`, styled and nothing more.
 *
 * There is no custom dropdown in this app and there is not going to be one. A
 * native select is keyboard-navigable, screen-reader friendly and correct on a
 * phone for free, all of which a div-based menu has to re-earn and usually does
 * not (PRD §12.4). The locale switcher and the tenant switcher both already
 * depend on this being true.
 */
export function Select({
  className,
  ...rest
}: React.ComponentPropsWithRef<"select">): React.ReactElement {
  return <select className={cn(inputRecipe(), "pr-8", className)} {...rest} />;
}
