import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Compose Tailwind classes so the caller's win.
 *
 * `clsx` flattens conditionals and arrays; `twMerge` then resolves *conflicts*
 * by keeping the last value in each Tailwind group.
 *
 * The second half is the point. Before this, shared styling was exported as
 * plain strings and composed by interpolation:
 *
 * ```ts
 * className={`${inputClass} max-w-sm`}   // works
 * className={`${inputClass} px-4`}       // does not — both px-* survive, and
 *                                        // whichever CSS rule was emitted last
 *                                        // wins, which is not the caller's
 * ```
 *
 * With `cn()`, `cn(inputRecipe(), "px-4")` drops the recipe's `px-*` and keeps
 * `px-4`, so a component's own class always overrides the default it was given.
 * That is what makes a variant recipe safe to expose.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
