import { cn } from "@/lib/utils";

import { Skeleton } from "./skeleton";

/**
 * Loading states built from {@link Skeleton} (phase-11-shadcn-adoption §3.8).
 *
 * Both replace a bare "Loading…" paragraph, and both keep it: the word moves
 * into a visually hidden span inside `role="status"`, and the shapes are
 * `aria-hidden`. A skeleton on its own says nothing to a screen reader, and
 * "nothing is happening" is the one thing a loading state must not say.
 *
 * The shapes are generic on purpose. They suggest where content will appear;
 * mirroring each screen exactly would mean a second copy of every layout to
 * keep in step with the first.
 */

/** A whole screen whose data has not arrived: a heading and a card of rows. */
export function PageLoading({
  label,
  className,
}: {
  /** The translated "Loading…", read out instead of shown. */
  label: string;
  className?: string;
}): React.ReactElement {
  return (
    <div role="status" className={cn("mx-auto flex max-w-5xl flex-col gap-6 p-8", className)}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="flex flex-col gap-6">
        <Skeleton className="h-8 w-56" />
        <div className="bg-card flex flex-col gap-4 rounded-xl border p-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </div>
    </div>
  );
}

/** A list or table inside a card whose rows have not arrived. */
export function ListLoading({
  label,
  rows = 3,
  className,
}: {
  label: string;
  rows?: number;
  className?: string;
}): React.ReactElement {
  return (
    <div role="status" className={cn("flex flex-col gap-3", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden="true" className="flex items-center gap-3">
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  );
}
