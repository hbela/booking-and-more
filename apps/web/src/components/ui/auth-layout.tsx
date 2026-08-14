import { getTranslations } from "next-intl/server";
import { Card } from "./card";

/**
 * The frame around a credential form: sign-in, sign-up, and the invitation
 * landing page.
 *
 * A centred card rather than the split-screen-with-artwork pattern, for a
 * reason specific to this product: these screens are reached by an owner
 * following a one-time emailed link, often on a phone, sometimes with an error
 * to read. A hero panel would push the form below the fold on exactly the
 * device that path is most used from, and buy nothing — the customer-facing
 * surface is the booking page, not this.
 *
 * `min-h-screen` with `justify-center` keeps a three-field form optically
 * centred while a six-field one still scrolls normally.
 */
export async function AuthLayout({
  title,
  description,
  children,
}: {
  title: string;
  description?: string | undefined;
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const common = await getTranslations("common");

  return (
    <main className="bg-surface-raised flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-md flex-col gap-6">
        <p className="text-primary font-display text-center text-sm font-semibold tracking-wide uppercase">
          {common("appName")}
        </p>

        <Card className="gap-6">
          <div className="flex flex-col gap-2">
            <h1 className="font-display text-ink text-2xl font-bold tracking-tight">{title}</h1>
            {description === undefined ? null : (
              <p className="text-ink-muted text-sm">{description}</p>
            )}
          </div>

          {children}
        </Card>
      </div>
    </main>
  );
}
