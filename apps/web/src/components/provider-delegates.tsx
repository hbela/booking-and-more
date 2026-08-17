"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ApiError,
  apiFetch,
  type DelegationCandidate,
  type DelegationScope,
  type ProviderDelegation,
} from "@/lib/api-client";
import { useDashboardContext } from "./dashboard-shell";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { Card } from "./ui/card";
import { ErrorText, Field } from "./ui/field";
import { Select } from "./ui/input";
import { DataTable, RowButton, Td, Th } from "./ui/table";

const SCOPES: DelegationScope[] = ["AVAILABILITY", "BOOKINGS"];

/**
 * Who runs this diary besides the provider.
 * docs/phase-3-4-diary-delegation.md §6.1.
 *
 * ## Why it lives on the availability screen
 *
 * A PROVIDER holds no `provider:manage`, so the navigation filter removes the
 * Providers screen for them entirely. Putting delegation there would make the
 * primary granter — the provider whose diary it is — unable to grant. This is
 * the one screen they already reach for their own diary, and phase-2-3 §2.9
 * already put diary decisions here.
 *
 * ## The render condition mirrors the API rule exactly
 *
 * `canDelegateProviderDiary` is `canForProvider` **without** a delegated
 * branch (§2.3), so the check below deliberately does not consult
 * `me.delegations`: a delegate must not be shown a panel the API would refuse,
 * and more importantly must not be shown a way to hand the diary on.
 */
export function ProviderDelegates({
  tenantId,
  providerId,
}: {
  tenantId: string;
  providerId: string;
}): React.ReactElement | null {
  const t = useTranslations("availability");
  const context = useDashboardContext();
  const queryClient = useQueryClient();

  const canDelegate =
    context.can("availability:manage:all") ||
    (context.can("availability:manage:own") &&
      context.me?.membership?.providerId === providerId);

  const [adding, setAdding] = useState(false);
  const [candidateId, setCandidateId] = useState("");
  const [draftScopes, setDraftScopes] = useState<DelegationScope[]>(["BOOKINGS"]);
  const [error, setError] = useState<string | null>(null);

  const delegations = useQuery({
    queryKey: ["delegations", providerId],
    queryFn: () =>
      apiFetch<{ items: ProviderDelegation[] }>(`/v1/providers/${providerId}/delegations`, {
        tenantId,
      }),
    enabled: canDelegate,
  });

  const candidates = useQuery({
    queryKey: ["delegation-candidates", providerId],
    queryFn: () =>
      apiFetch<{ items: DelegationCandidate[] }>(
        `/v1/providers/${providerId}/delegations/candidates`,
        { tenantId },
      ),
    // Only when the picker is open: the list is a second round trip and every
    // provider loading their own schedule would otherwise pay for it.
    enabled: canDelegate && adding,
  });

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: ["delegations", providerId] });
    void queryClient.invalidateQueries({ queryKey: ["delegation-candidates", providerId] });
  }

  const save = useMutation({
    mutationFn: (args: { membershipId: string; scopes: DelegationScope[] }) =>
      apiFetch(`/v1/providers/${providerId}/delegations/${args.membershipId}`, {
        method: "PUT",
        tenantId,
        body: { scopes: args.scopes },
      }),
    onSuccess: () => {
      setError(null);
      setAdding(false);
      setCandidateId("");
      setDraftScopes(["BOOKINGS"]);
      invalidate();
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("delegateFailed"));
    },
  });

  const revoke = useMutation({
    mutationFn: (membershipId: string) =>
      apiFetch(`/v1/providers/${providerId}/delegations/${membershipId}`, {
        method: "DELETE",
        tenantId,
      }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("delegateFailed"));
    },
  });

  if (!canDelegate) return null;

  const rows = delegations.data?.items ?? [];
  const available = (candidates.data?.items ?? []).filter((entry) => !entry.alreadyDelegated);

  /**
   * Toggling the last scope off is a revocation, not a grant of nothing — the
   * database refuses an empty array and so does the schema. Offered as an
   * explicit Revoke instead, so the destructive act is named.
   */
  function toggleScope(row: ProviderDelegation, scope: DelegationScope): void {
    const next = row.scopes.includes(scope)
      ? row.scopes.filter((entry) => entry !== scope)
      : [...row.scopes, scope];

    if (next.length === 0) {
      setError(t("delegateNeedsOneScope"));
      return;
    }

    save.mutate({ membershipId: row.member.membershipId, scopes: next });
  }

  function toggleDraftScope(scope: DelegationScope): void {
    setDraftScopes((current) =>
      current.includes(scope)
        ? current.filter((entry) => entry !== scope)
        : [...current, scope],
    );
  }

  return (
    <Card
      title={t("delegates")}
      description={t("delegatesHint")}
      actions={
        adding ? null : (
          <Button
            variant="secondary"
            onClick={() => {
              setAdding(true);
              setError(null);
            }}
          >
            {t("delegateAdd")}
          </Button>
        )
      }
    >
      {error === null ? null : <ErrorText>{error}</ErrorText>}

      {rows.length === 0 && !adding ? (
        // The day-2 trap (§6.5): a provider added after the migration has no
        // delegates and the front desk silently loses them. A `tone="action"`
        // callout is the pattern phase-2-3 established for configuration that
        // looks finished and produces nothing.
        <Callout tone="action">{t("delegatesEmpty")}</Callout>
      ) : null}

      {rows.length > 0 ? (
        <DataTable
          caption={t("delegates")}
          head={
            <tr>
              <Th>{t("delegateMember")}</Th>
              <Th>{t("delegateScopes")}</Th>
              <Th>
                <span className="sr-only">{t("delegateActions")}</span>
              </Th>
            </tr>
          }
        >
          {rows.map((row) => (
            <tr key={row.member.membershipId}>
              <Td>
                <span className="flex flex-col">
                  <span className="font-medium">{row.member.name}</span>
                  <span className="text-ink-muted text-xs">{row.member.email}</span>
                  {row.member.roleReceivesDelegations ? null : (
                    // The grant survives a role change and confers nothing
                    // (§2.8). Surfaced where it can be fixed, rather than
                    // discovered as an access mystery.
                    <Badge tone="warning" className="mt-1 self-start">
                      {t("delegateStaleRole")}
                    </Badge>
                  )}
                </span>
              </Td>
              <Td>
                <span className="flex flex-wrap gap-3">
                  {SCOPES.map((scope) => (
                    <label key={scope} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={row.scopes.includes(scope)}
                        disabled={save.isPending}
                        onChange={() => {
                          toggleScope(row, scope);
                        }}
                      />
                      {scope === "AVAILABILITY"
                        ? t("delegateScopeAvailability")
                        : t("delegateScopeBookings")}
                    </label>
                  ))}
                </span>
              </Td>
              <Td className="text-right">
                <RowButton
                  disabled={revoke.isPending}
                  onClick={() => {
                    if (!window.confirm(t("delegateRevokeConfirm", { name: row.member.name }))) {
                      return;
                    }
                    revoke.mutate(row.member.membershipId);
                  }}
                >
                  {t("delegateRevoke")}
                </RowButton>
              </Td>
            </tr>
          ))}
        </DataTable>
      ) : null}

      {adding ? (
        <div className="flex flex-col gap-3">
          <Field id="delegate-candidate" label={t("delegateChoose")}>
            <Select
              id="delegate-candidate"
              value={candidateId}
              onChange={(event) => {
                setCandidateId(event.target.value);
              }}
              className="max-w-sm"
            >
              <option value="">—</option>
              {available.map((entry) => (
                <option key={entry.membershipId} value={entry.membershipId}>
                  {entry.name} ({entry.email})
                </option>
              ))}
            </Select>
          </Field>

          {candidates.isSuccess && available.length === 0 ? (
            <Callout tone="action">{t("delegateNoCandidates")}</Callout>
          ) : null}

          <fieldset className="flex flex-col gap-2">
            <legend className="text-ink text-sm font-medium">{t("delegateScopes")}</legend>
            {SCOPES.map((scope) => (
              <label key={scope} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draftScopes.includes(scope)}
                  onChange={() => {
                    toggleDraftScope(scope);
                  }}
                  className="mt-1"
                />
                <span className="flex flex-col">
                  <span>
                    {scope === "AVAILABILITY"
                      ? t("delegateScopeAvailability")
                      : t("delegateScopeBookings")}
                  </span>
                  <span className="text-ink-muted text-xs">
                    {scope === "AVAILABILITY"
                      ? t("delegateScopeAvailabilityHint")
                      : t("delegateScopeBookingsHint")}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="flex gap-2">
            <Button
              disabled={candidateId === "" || draftScopes.length === 0 || save.isPending}
              onClick={() => {
                if (draftScopes.length === 0) {
                  setError(t("delegateNeedsOneScope"));
                  return;
                }
                save.mutate({ membershipId: candidateId, scopes: draftScopes });
              }}
            >
              {t("delegateGrant")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
            >
              {t("delegateCancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
