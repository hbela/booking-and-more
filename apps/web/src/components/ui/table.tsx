import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

import { buttonVariants } from "./button";

/**
 * shadcn/ui's Table parts, plus this app's `DataTable` composite and row
 * actions (phase-11-shadcn-adoption §3.6).
 *
 * A real `<table>`, never a grid of divs: the screens here show tabular data —
 * bookings by day, services with prices, providers with locations — and a table
 * gives row and column association to assistive technology for free.
 *
 * One departure from the registry: **`TableCell` does not `whitespace-nowrap`.**
 * An address or a member's email would otherwise stretch a table to many
 * screens wide; the wrapper scrolls horizontally when a table is genuinely
 * wider than a phone, and cells wrap the rest of the time. Headers keep it.
 */
function Table({ className, ...props }: React.ComponentProps<"table">): React.ReactElement {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">): React.ReactElement {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">): React.ReactElement {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">): React.ReactElement {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("bg-muted/50 border-t font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">): React.ReactElement {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors",
        className,
      )}
      {...props}
    />
  );
}

/** `scope="col"` by default: a header in `<thead>` names the column below it. */
function TableHead({
  className,
  scope = "col",
  ...props
}: React.ComponentProps<"th">): React.ReactElement {
  return (
    <th
      data-slot="table-head"
      scope={scope}
      className={cn(
        "text-foreground h-10 px-2 text-left align-middle font-medium whitespace-nowrap",
        "[&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">): React.ReactElement {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">): React.ReactElement {
  return (
    <caption
      data-slot="table-caption"
      className={cn("text-muted-foreground mt-4 text-sm", className)}
      {...props}
    />
  );
}

/**
 * A bordered table with a sunken header and a required, visually hidden
 * caption — so it has a name when read out of context. Composed from the
 * parts above; use them directly for a table that wants a visible caption or
 * no frame.
 */
function DataTable({
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
    <div className={cn("overflow-hidden rounded-xl border", className)}>
      <Table>
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader className="bg-surface-sunken">{head}</TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

/**
 * Compact actions at the end of a table row: the outline button, smaller.
 *
 * **Below the 44px target, and deliberately so** — a row carries two or three
 * of these, and at 44px every table doubles in height. That was already true
 * of the phase-11 version; this keeps it rather than introducing it.
 *
 * Two components rather than one, because the distinction is semantic:
 * {@link RowLink} navigates and must be an anchor (middle-click opens a tab, a
 * screen reader says "link"); {@link RowButton} acts on the current screen.
 */
const rowAction = cn(
  buttonVariants({ variant: "outline", size: "sm" }),
  "min-h-8 px-2.5 py-1 text-xs",
);

function RowLink({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <Link href={href} className={cn(rowAction, className)}>
      {children}
    </Link>
  );
}

function RowButton({
  onClick,
  className,
  children,
  ...rest
}: {
  onClick: () => void;
  children: React.ReactNode;
} & Omit<React.ComponentPropsWithRef<"button">, "onClick" | "children">): React.ReactElement {
  return (
    <button type="button" onClick={onClick} className={cn(rowAction, className)} {...rest}>
      {children}
    </button>
  );
}

export {
  DataTable,
  RowButton,
  RowLink,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
};
