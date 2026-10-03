import { cn } from "@/lib/utils";

/**
 * shadcn/ui's Input, adapted per phase-11-shadcn-adoption §2.4.
 *
 * - **No `outline-none` / `ring-ring/50`** — the global `:focus-visible`
 *   outline is the contrast-tested focus indicator.
 * - **`min-h-11`**, the 44px touch target, not the registry's `h-9`.
 * - **`bg-background` in both themes**, not `bg-transparent` / `dark:bg-input/30`:
 *   a field sitting on a raised card must still read as a field.
 * - `border-input` is `--line-strong`, the 3:1 control boundary (WCAG 1.4.11).
 *
 * `text-base` below `md` is the registry's and is kept on purpose: iOS zooms
 * the page into any focused field under 16px.
 */
export const controlClasses = [
  "border-input bg-background text-foreground w-full min-w-0 rounded-md border shadow-xs",
  "placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground",
  "disabled:cursor-not-allowed disabled:opacity-60",
  "aria-invalid:border-destructive",
];

function Input({ className, type, ...props }: React.ComponentProps<"input">): React.ReactElement {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        controlClasses,
        "min-h-11 px-3 py-2 text-base md:text-sm",
        "file:text-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
