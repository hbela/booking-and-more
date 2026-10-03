import { cn } from "@/lib/utils";

/**
 * shadcn/ui's Skeleton: a placeholder shape while content loads. Decorative —
 * callers hide it from assistive technology and say "Loading…" in text; see
 * `./loading.tsx`, which does both.
 *
 * Two departures (phase-11-shadcn-adoption §3.8): **`bg-muted`, not
 * `bg-accent`** — our `--accent` is the raised surface, which is all but
 * invisible on a white card; and **`motion-reduce:animate-none`**, so a visitor
 * who asked the operating system for less motion gets a still shape.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      data-slot="skeleton"
      className={cn("bg-muted animate-pulse rounded-md motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

export { Skeleton };
