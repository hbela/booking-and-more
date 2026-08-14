import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The only way a lucide icon enters the app.
 *
 * `lucide-react` has been a dependency since Epic 0 and was never imported —
 * there is no icon anywhere in the product today. Introducing several hundred
 * of them at once is exactly when the accessibility tree gets polluted, so the
 * default here is the safe one and the unsafe one has to be asked for.
 *
 * **Decorative by default.** An icon beside a text label says nothing a screen
 * reader user needs; announcing "image" before every button label is noise. So
 * `aria-hidden` unless a `title` is passed, and `focusable="false"` because IE
 * and old Edge put SVGs in the tab order. This repo already refuses disabled
 * anchors and custom dropdowns for the same class of reason.
 *
 * `title` is for the rare icon that *is* the content — a status glyph in a table
 * cell with no adjacent word. Note that an icon-only *button* does not want
 * this: label the button, not the glyph, so the accessible name sits on the
 * thing that is actually focusable.
 */
export function Icon({
  as: Glyph,
  title,
  size = 16,
  className,
}: {
  as: LucideIcon;
  /** Announce the icon under this name. Omit for decoration — the default. */
  title?: string;
  size?: number;
  className?: string;
}): React.ReactElement {
  return (
    <Glyph
      width={size}
      height={size}
      // Scales with the surrounding text rather than the root font size, so an
      // icon inside a 12px badge is not the same size as one in a heading.
      strokeWidth={1.75}
      className={cn("shrink-0", className)}
      focusable="false"
      {...(title === undefined
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": title })}
    />
  );
}
