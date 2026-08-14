import { cn } from "@/lib/cn";
import { Card } from "./card";

/**
 * A titled region of a screen.
 *
 * There were three of these — `Section` in `dashboard-shell.tsx`,
 * `BookingSection` in `booking-flow.tsx`, and a private one in
 * `manage-booking.tsx` — differing only in whether the region was bordered.
 * That is a variant, not three components.
 *
 * `variant="plain"` reproduces the dashboard one exactly (heading plus a gap-3
 * column), so existing screens are unchanged by adopting it.
 *
 * `headingLevel` exists because a section nested inside a `Card` that already
 * has an `<h2>` needs an `<h3>`, and a silently wrong heading order is one of
 * the easiest accessibility regressions to ship in a redesign.
 */
export function Section({
  title,
  description,
  actions,
  variant = "plain",
  headingLevel = 2,
  className,
  children,
}: {
  title?: string | undefined;
  description?: string | undefined;
  actions?: React.ReactNode | undefined;
  variant?: "plain" | "card" | undefined;
  headingLevel?: 2 | 3 | 4 | undefined;
  className?: string | undefined;
  children: React.ReactNode;
}): React.ReactElement {
  if (variant === "card") {
    return (
      <Card title={title} description={description} actions={actions} className={className}>
        {children}
      </Card>
    );
  }

  const Heading = `h${headingLevel}` as const;

  return (
    <section className={cn("flex flex-col gap-3", className)}>
      {title === undefined && actions === undefined ? null : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            {title === undefined ? null : (
              <Heading className="font-display text-ink text-lg font-semibold">{title}</Heading>
            )}
            {description === undefined ? null : (
              <p className="text-ink-muted text-sm">{description}</p>
            )}
          </div>
          {actions}
        </div>
      )}

      {children}
    </section>
  );
}
