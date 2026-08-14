"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ReadinessResponse } from "@bam/contracts";
import { Badge } from "./ui/badge";

const API_BASE_URL = process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "http://localhost:3001";

/**
 * Live readiness of the Fastify API.
 *
 * Present in Phase 0 to prove the web -> API path actually works end to end,
 * which is one of the phase's exit criteria. It also demonstrates the shared
 * contract: `ReadinessResponse` is imported from @bam/contracts, so if the API
 * changes the shape, this file stops compiling.
 */
export function ApiStatus(): React.ReactElement {
  const t = useTranslations("home.apiStatus");

  const { data, isPending, isError } = useQuery({
    queryKey: ["health", "ready"],
    queryFn: async (): Promise<ReadinessResponse> => {
      // `/health/ready` answers 503 when degraded, which is a valid, parseable
      // response — not a transport failure.
      const response = await fetch(`${API_BASE_URL}/health/ready`);
      return (await response.json()) as ReadinessResponse;
    },
    refetchInterval: 15_000,
  });

  const describe = (status: string): string => {
    if (status === "ok") return t("statusOk");
    if (status === "not_configured") return t("statusNotConfigured");
    return t("statusDown");
  };

  return (
    <section
      aria-labelledby="api-status-heading"
      className="border-line bg-surface rounded-xl border p-6"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="api-status-heading" className="text-ink text-sm font-semibold tracking-wide uppercase">
          {t("heading")}
        </h2>
        {/* The badge carries a word, never a bare coloured dot: colour alone
            fails WCAG 1.4.1, and "is the API up" is exactly the sort of thing a
            reader should not have to infer from a hue. */}
        <Badge tone={isPending ? "neutral" : isError ? "danger" : "success"}>
          {isPending ? t("checking") : isError ? t("unreachable") : t("ok")}
        </Badge>
      </div>

      {data ? (
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-ink-muted">{t("postgres")}</dt>
          <dd className="text-ink">{describe(data.checks.postgres.status)}</dd>
          <dt className="text-ink-muted">{t("redis")}</dt>
          <dd className="text-ink">{describe(data.checks.redis.status)}</dd>
        </dl>
      ) : null}
    </section>
  );
}
