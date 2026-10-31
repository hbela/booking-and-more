import { getTranslations } from "next-intl/server";
import type { LegalDocument } from "@/content/legal";

/** Renders one legal text, with a contents list whose links are the section anchors. */
export async function LegalDocumentView({
  document,
  locale,
}: {
  document: LegalDocument;
  locale: string;
}): Promise<React.ReactElement> {
  const t = await getTranslations("legal");
  const effective = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(`${document.effective}T00:00:00Z`),
  );

  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
        {document.title}
      </h1>
      <p className="text-ink-muted mt-2 text-sm">{t("effective", { date: effective })}</p>

      <div className="mt-6 flex flex-col gap-4 leading-relaxed">
        {document.intro.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>

      <nav aria-label={t("contents")} className="border-line mt-8 rounded-xl border p-5">
        <ol className="flex flex-col gap-1 text-sm">
          {document.sections.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`} className="underline-offset-4 hover:underline">
                {section.heading}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {document.sections.map((section) => (
        <section key={section.id} id={section.id} className="mt-10 scroll-mt-6">
          <h2 className="font-display text-xl font-bold">{section.heading}</h2>
          <div className="mt-3 flex flex-col gap-3 leading-relaxed">
            {section.blocks.map((block, index) =>
              typeof block === "string" ? (
                <p key={index}>{block}</p>
              ) : (
                <ul key={index} className="list-disc space-y-2 pl-5">
                  {block.list.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ),
            )}
          </div>
        </section>
      ))}
    </article>
  );
}
