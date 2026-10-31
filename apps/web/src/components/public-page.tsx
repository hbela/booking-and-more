import { getTranslations } from "next-intl/server";
import { AuthHeader } from "@/components/auth-header";
import { Brand } from "@/components/brand";
import { Link } from "@/i18n/navigation";
import { getLegalEntity, HOSTING_PROVIDER } from "@/lib/legal-entity";

/**
 * The frame of the product's own public pages: the home page, pricing and the
 * three legal texts (docs/public-site-and-legal-pages.md §2). Tenant booking
 * pages do not use it — they present the clinic, not us.
 */
export function PublicHeader(): React.ReactElement {
  return (
    <div className="border-line border-b">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-end justify-between gap-6 px-6 py-4">
        <Link
          href="/"
          className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4"
        >
          <Brand />
        </Link>
        <AuthHeader signOutTo="/" />
      </div>
    </div>
  );
}

/**
 * Links to pricing and the legal texts, and the impresszum Ekertv. 4. § asks
 * for. The seller's details come from runtime configuration, so this renders
 * per request; a field left unset is omitted (legal-entity.ts).
 */
export async function PublicFooter(): Promise<React.ReactElement> {
  const t = await getTranslations("legal");
  const entity = getLegalEntity();

  const details: [string, React.ReactNode][] = [];
  if (entity.name) details.push([t("seller"), entity.name]);
  if (entity.address) details.push([t("address"), entity.address]);
  if (entity.taxNumber) details.push([t("taxNumber"), entity.taxNumber]);
  if (entity.euVatNumber) details.push([t("euVatNumber"), entity.euVatNumber]);
  if (entity.registrationNumber) details.push([t("registrationNumber"), entity.registrationNumber]);
  if (entity.email)
    details.push([
      t("email"),
      <a key="email" href={`mailto:${entity.email}`} className="underline underline-offset-4">
        {entity.email}
      </a>,
    ]);
  details.push([t("hosting"), HOSTING_PROVIDER]);

  return (
    <footer className="border-line bg-surface-raised mt-auto border-t">
      <div className="mx-auto grid w-full max-w-5xl gap-8 px-6 py-10 text-sm md:grid-cols-[1fr_2fr]">
        <nav aria-label={t("footerNav")}>
          <ul className="flex flex-col gap-1">
            {(
              [
                ["/pricing", t("pricing")],
                ["/terms", t("terms")],
                ["/privacy", t("privacy")],
                ["/refund", t("refund")],
              ] as const
            ).map(([href, label]) => (
              <li key={href}>
                <Link
                  href={href}
                  className="inline-flex min-h-11 items-center underline-offset-4 hover:underline"
                >
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <section aria-labelledby="legal-notice">
          <h2 id="legal-notice" className="font-semibold">
            {t("legalNotice")}
          </h2>
          <dl className="text-ink-muted mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
            {details.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-ink">{label}</dt>
                <dd className="mb-2 break-words sm:mb-0">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </footer>
  );
}
