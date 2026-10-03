import { ChevronDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { controlClasses } from "./input";

/**
 * shadcn/ui's NativeSelect — a real `<select>`, styled.
 *
 * **Never replace this with shadcn's Radix `Select`** (phase-11 §2.6,
 * phase-11-shadcn-adoption §2.3). A native select is keyboard-navigable,
 * screen-reader friendly and correct on a phone for free.
 *
 * Departures from the registry copy, beyond the §2.4 ones in
 * {@link ./input.tsx}:
 *
 * - **`className` styles the wrapper**, which is full-width by default. The
 *   chevron is positioned against the wrapper, so a width set on the
 *   `<select>` alone (`max-w-sm`) would leave the chevron floating at the far
 *   edge. Pass `w-auto` for a select that sits inline in a header.
 * - **The wrapper is a `<span>`**, not the registry's `<div>`: the locale and
 *   theme switchers put the select inside its `<label>`, and a `<label>` may
 *   only contain phrasing content.
 * - The chevron is not dimmed to 50 %: with `appearance-none` it is the only
 *   thing saying "this opens".
 */
function NativeSelect({
  className,
  selectClassName,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & {
  size?: "sm" | "default";
  /** Classes for the `<select>` itself; `className` goes to the wrapper. */
  selectClassName?: string;
}): React.ReactElement {
  return (
    <span
      className={cn(
        "group/native-select relative block w-full has-[select:disabled]:opacity-60",
        className,
      )}
      data-slot="native-select-wrapper"
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          controlClasses,
          "min-h-11 appearance-none px-3 py-2 pr-9 text-base md:text-sm",
          selectClassName,
        )}
        {...props}
      />
      <ChevronDownIcon
        className="text-muted-foreground pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </span>
  );
}

/**
 * `Canvas` / `CanvasText` follow `color-scheme`, which globals.css resolves to
 * exactly `light` or `dark` (phase-11 §2.4) — so the open list matches the
 * visitor's chosen theme, not the operating system's.
 */
function NativeSelectOption({
  className,
  ...props
}: React.ComponentProps<"option">): React.ReactElement {
  return (
    <option
      data-slot="native-select-option"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  );
}

function NativeSelectOptGroup({
  className,
  ...props
}: React.ComponentProps<"optgroup">): React.ReactElement {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
