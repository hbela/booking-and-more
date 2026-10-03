import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * shadcn/ui's Card, adapted (phase-11-shadcn-adoption §3.5).
 *
 * **`Card` is a `<section>`, not the registry's `<div>`, and spreads its props
 * onto it** so `useEditPanel`'s `panelProps` reach the DOM — that is how an
 * editing panel becomes focusable and addressable by its row button's
 * `aria-controls`. `id`, `ref` and `tabIndex={-1}` all have to arrive. There is
 * deliberately no `focus:outline-none`: when the panel takes focus
 * programmatically, the global `:focus-visible` ring is the only thing telling
 * the user where they landed (phase-11 §2.6 — there is no edit dialog to do it
 * for them).
 */
function Card({ className, ...props }: React.ComponentProps<"section">): React.ReactElement {
  return (
    <section
      data-slot="card"
      className={cn(
        "bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6",
        "has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className,
      )}
      {...props}
    />
  );
}

/**
 * **A real heading, `<h2>` by default** — the registry renders a `<div>`, which
 * would take every card title out of the heading outline a screen-reader user
 * navigates by. For another level, wrap one: `<CardTitle asChild><h1>…</h1></CardTitle>`.
 */
function CardTitle({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"h2"> & { asChild?: boolean }): React.ReactElement {
  const Comp = asChild ? Slot.Root : "h2";

  return (
    <Comp
      data-slot="card-title"
      className={cn("font-display text-lg leading-snug font-semibold", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">): React.ReactElement {
  return (
    <p
      data-slot="card-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

/**
 * Buttons that belong to the card as a whole, aligned with its title.
 * `flex flex-wrap gap-2` is ours: callers pass several buttons, and on a phone
 * they wrap rather than push the title off the edge.
 */
function CardAction({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 flex flex-wrap gap-2 self-start justify-self-end",
        className,
      )}
      {...props}
    />
  );
}

/**
 * `flex flex-col gap-4` is ours, not the registry's: every card body in the app
 * is a stack of blocks, and the phase-11 `Card` spaced its children that way.
 */
function CardContent({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      data-slot="card-content"
      className={cn("flex flex-col gap-4 px-6", className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      {...props}
    />
  );
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
