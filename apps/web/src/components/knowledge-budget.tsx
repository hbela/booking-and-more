"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { KnowledgeUsage, Language } from "@bam/contracts";
import { apiFetch, ApiError } from "@/lib/api-client";

export function isKnowledgeLimitError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    typeof error.details === "object" &&
    error.details !== null &&
    "field" in error.details &&
    error.details.field === "knowledge"
  );
}

/** Shows persisted totals plus the current form's unsaved changes. */
export function KnowledgeBudget({
  tenantId,
  changes = {},
  baseDescriptionChange = 0,
}: {
  tenantId: string;
  changes?: Partial<Record<Language, number>>;
  baseDescriptionChange?: number;
}) {
  const t = useTranslations("knowledgeBudget");
  const locale = useLocale();
  const usage = useQuery({
    queryKey: ["knowledge-usage", tenantId],
    queryFn: () => apiFetch<KnowledgeUsage>("/v1/services/knowledge-usage", { tenantId }),
    enabled: Boolean(tenantId),
  });
  if (usage.isError) return <p role="alert">{t("loadError")}</p>;
  if (!usage.data) return null;
  return (
    <div className="grid gap-1 text-sm" aria-live="polite">
      {/* The limit comes from the API, so the copy cannot drift from it again. */}
      <p className="text-ink-muted">
        {t("hint", { limit: new Intl.NumberFormat(locale).format(usage.data.limit) })}
      </p>
      {usage.data.locales.map((entry) => {
        const used =
          entry.used +
          (changes[entry.locale] ?? 0) +
          (entry.locale === usage.data.defaultLocale ? baseDescriptionChange : 0);
        return (
          <p
            key={entry.locale}
            className={used > usage.data.limit ? "text-warning" : "text-ink-muted"}
          >
            {t("usage", { language: entry.locale.toUpperCase(), used, limit: usage.data.limit })}
            {used > usage.data.limit ? ` ${t("over")}` : ""}
          </p>
        );
      })}
    </div>
  );
}
