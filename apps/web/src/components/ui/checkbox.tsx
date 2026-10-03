"use client";

import { CheckIcon } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui's Checkbox — a Radix `<button role="checkbox">`, not an `<input>`.
 *
 * Two consequences for callers (phase-11-shadcn-adoption §3.4):
 *
 * - **`onCheckedChange`, not `onChange`**, and it receives
 *   `boolean | "indeterminate"`. Compare with `=== true`.
 * - **Wrapping it in a `<label>` still works**: a `<button>` is labelable, so
 *   the label names it and a click anywhere on the label toggles it. Inside a
 *   `<form>`, Radix renders a hidden input carrying `name` / `value` (`"on"`),
 *   so `FormData` reads it exactly as it read the native checkbox.
 *
 * Departures from the registry copy, per §2.4: no `outline-none` or 50 % ring
 * (the global `:focus-visible` outline applies), and `bg-background` in dark
 * mode instead of a tinted `bg-input/30`. `border-input` is `--line-strong`,
 * the 3:1 boundary an unchecked box needs to be seen at all.
 */
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>): React.ReactElement {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer border-input bg-background size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "aria-invalid:border-destructive",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
