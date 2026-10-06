"use client";

import { knowledgeCharacters } from "@bam/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ApiError, apiFetch, type Service } from "@/lib/api-client";
import { KnowledgeBudget, isKnowledgeLimitError } from "./knowledge-budget";
import {
  ServiceFields,
  serviceBodyFrom,
  serviceStateFrom,
  type ServiceFormState,
} from "./service-fields";
import { Button } from "./ui/button";
import { ErrorText } from "./ui/form-field";

/**
 * The create form on its own, so a proposal from the website import
 * (docs/phase-12-site-import.md §4) goes through exactly the path a typed
 * service does: same fields, same validation, same budget.
 */
export function CreateServiceForm({
  tenantId,
  idPrefix,
  initial,
  onCreated,
}: {
  tenantId: string;
  idPrefix: string;
  /** Pre-filled fields; anything not given starts as a new service does. */
  initial?: Partial<ServiceFormState>;
  onCreated?: (service: Service) => void;
}): React.ReactElement {
  const t = useTranslations("catalogue");
  const budgetText = useTranslations("knowledgeBudget");
  const queryClient = useQueryClient();

  const [state, setState] = useState<ServiceFormState>(() => ({
    ...serviceStateFrom(),
    ...initial,
  }));
  const [error, setError] = useState<string | null>(null);
  const [slugTaken, setSlugTaken] = useState(false);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<Service>("/v1/services", {
        method: "POST",
        tenantId,
        body: serviceBodyFrom(state, "create"),
      }),
    onSuccess: (service) => {
      setState(serviceStateFrom());
      void queryClient.invalidateQueries({ queryKey: ["services"] });
      void queryClient.invalidateQueries({ queryKey: ["knowledge-usage"] });
      onCreated?.(service);
    },
    onError: (cause: unknown) => {
      // The slug index covers archived rows, so this error usually means the
      // name is held by something the owner archived — and cannot see. Saying
      // so turns the most confusing possible failure into an instruction.
      setSlugTaken(cause instanceof ApiError && cause.code === "SLUG_TAKEN");
      setError(
        isKnowledgeLimitError(cause)
          ? budgetText("error")
          : cause instanceof ApiError
            ? cause.message
            : t("genericError"),
      );
    },
  });

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSlugTaken(false);
        mutation.mutate();
      }}
    >
      <ServiceFields
        state={state}
        idPrefix={idPrefix}
        onChange={(patch) => {
          setState((current) => ({ ...current, ...patch }));
        }}
      />

      <KnowledgeBudget
        tenantId={tenantId}
        baseDescriptionChange={knowledgeCharacters(state.description)}
      />
      <ErrorText>{error}</ErrorText>
      {slugTaken ? <p className="text-sm text-ink-muted">{t("slugTakenArchivedHint")}</p> : null}

      <Button type="submit" disabled={mutation.isPending}>
        {t("create")}
      </Button>
    </form>
  );
}
