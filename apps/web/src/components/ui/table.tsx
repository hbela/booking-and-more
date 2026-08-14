import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/cn";

/**
 * Compact actions that live at the end of a table row.
 *
 * Two components rather than one styled element, because the distinction is
 * semantic and load-bearing: {@link RowLink} navigates and must be an anchor
 * (middle-click opens a tab, a screen reader says "link"); {@link RowButton}
 * acts on the current screen and must be a button.
 */
const ROW_ACTION = "border-line-strong text-ink hover:bg-surface-raised rounded-md border px-2 py-1 text-xs";

export function RowLink({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <Link href={href} className={cn(ROW_ACTION, className)}>
      {children}
    </Link>
  );
}

export function RowButton({
  onClick,
  className,
  children,
  ...rest
}: {
  onClick: () => void;
  children: React.ReactNode;
} & Omit<React.ComponentPropsWithRef<"button">, "onClick" | "children">): React.ReactElement {
  return (
    <button type="button" onClick={onClick} className={cn(ROW_ACTION, className)} {...rest}>
      {children}
    </button>
  );
}

/**
 * The chrome of a data table, so twelve screens stop each inventing their own.
 *
 * A real `<table>`, not a grid of divs: the screens here show tabular data —
 * bookings by day, services with prices, providers with locations — and a table
 * gives row and column association to assistive technology for free. `<caption>`
 * is visually hidden rather than omitted, so the table has a name when read out
 * of context.
 *
 * `overflow-x-auto` on the wrapper, because a booking table on a phone is wider
 * than the phone and horizontal scrolling inside the table beats reflowing the
 * whole page.
 */
export function DataTable({
  caption,
  head,
  children,
  className,
}: {
  /** Names the table for assistive technology. Required, not optional. */
  caption: string;
  head: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("border-line overflow-x-auto rounded-xl border", className)}>
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-surface-sunken text-ink-muted text-xs uppercase">{head}</thead>
        <tbody className="divide-line divide-y">{children}</tbody>
      </table>
    </div>
  );
}

export function Th({
  children,
  className,
  ...rest
}: React.ComponentPropsWithRef<"th">): React.ReactElement {
  return (
    <th scope="col" className={cn("px-4 py-3 font-semibold", className)} {...rest}>
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  ...rest
}: React.ComponentPropsWithRef<"td">): React.ReactElement {
  return (
    <td className={cn("text-ink px-4 py-3 align-middle", className)} {...rest}>
      {children}
    </td>
  );
}
