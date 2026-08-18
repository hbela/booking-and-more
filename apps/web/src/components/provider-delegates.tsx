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
import type { EditPanel } from "@/lib/use-edit-panel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { Card } from "./ui/card";
import { ErrorText, Field, TextField } from "./ui/field";
import { Select } from "./ui/input";
import { DataTable, RowButton, Td, Th } from "./ui/table";

const SCOPES: DelegationScope[] = ["AVAILABILITY", "BOOKINGS"];

/**
 * Who assists on this diary.
 * docs/phase-3-4-diary-delegation.md §6.1.
 *
 * ## Two audiences, one panel
 *
 * **The owner** decides: assign an existing member, invite somebody who has no
 * account yet, change what a grant covers, take it back. **The provider** whose
 * diary it is only reads — they do not choose their assistants, and the panel
 * renders without a single control for them.
 *
 * That split is `delegation:manage` versus `availability:manage:own`, and it is
 * the API's rule exactly (§2.3). An ADMIN sees nothing here at all, despite
 * being able to edit every schedule in the clinic: staffing is the owner's.
 *
 * ## Why it lives on the availability screen
 *
 * A PROVIDER holds no `provider:manage`, so the navigation filter removes the
 * Providers screen for them entirely. This is the one screen they reach for
 * their own diary, and it is where "who has my week" belongs.
 *
 * ## Also a row panel on Providers
 *
 * The owner's route into staffing used to be "open the diary, scroll past
 * working hours and exceptions" — which reads as an availability setting rather
 * than as staffing, and staffing is neither (§2.3). So the Providers row opens
 * this same component as a `useEditPanel` panel: `panelProps` carries the focus
 * and `aria-controls` wiring, `providerName` says whose diary is open when the
 * screen shows several, and `onClose` gives the panel a way back.
 *
 * Deliberately the same component and not a simpler second one. "Who assists on
 * this diary" has one implementation, so a rule that holds on one screen — the
 * empty-scope refusal, the stale-role badge, the once-only invitation link —
 * cannot hold on only one of two.
 */
export function ProviderDelegates({
  tenantId,
  providerId,
  providerName,
  panelProps,
  onClose,
}: {
  tenantId: string;
  providerId: string;
  /** Set when the panel is opened from a list, where "this diary" is ambiguous. */
  providerName?: string | undefined;
  panelProps?: EditPanel["panelProps"] | undefined;
  onClose?: (() => void) | undefined;
}): React.ReactElement | null {
  const t = useTranslations("availability");
  const context = useDashboardContext();
  const queryClient = useQueryClient();

  const canManage = context.can("delegation:manage");
  const isOwnDiary = context.me?.membership?.providerId === providerId;

  const [mode, setMode] = useState<"idle" | "assign" | "invite">("idle");
  const [candidateId, setCandidateId] = useState("");
  const [email, setEmail] = useState("");
  const [draftScopes, setDraftScopes] = useState<DelegationScope[]>(["BOOKINGS"]);
  const [error, setError] = useState<string | null>(null);
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);

  const delegations = useQuery({
    queryKey: ["delegations", providerId],
    queryFn: () =>
      apiFetch<{ items: ProviderDelegation[] }>(`/v1/providers/${providerId}/delegations`, {
        tenantId,
      }),
    enabled: canManage || isOwnDiary,
  });

  const candidates = useQuery({
    queryKey: ["delegation-candidates", providerId],
    queryFn: () =>
      apiFetch<{ items: DelegationCandidate[] }>(
        `/v1/providers/${providerId}/delegations/candidates`,
        { tenantId },
      ),
    // Only while the picker is open: a second round trip every provider would
    // otherwise pay for on every visit to their own schedule.
    enabled: canManage && mode === "assign",
  });

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: ["delegations", providerId] });
    void queryClient.invalidateQueries({ queryKey: ["delegation-candidates", providerId] });
  }

  function reset(): void {
    setMode("idle");
    setCandidateId("");
    setEmail("");
    setDraftScopes(["BOOKINGS"]);
    setError(null);
  }

  function failed(cause: unknown): void {
    setError(cause instanceof ApiError ? cause.message : t("delegateFailed"));
  }

  const save = useMutation({
    mutationFn: (args: { membershipId: string; scopes: DelegationScope[] }) =>
      apiFetch(`/v1/providers/${providerId}/delegations/${args.membershipId}`, {
        method: "PUT",
        tenantId,
        body: { scopes: args.scopes },
      }),
    onSuccess: () => {
      reset();
      invalidate();
    },
    onError: failed,
  });

  const invite = useMutation({
    mutationFn: (args: { email: string; scopes: DelegationScope[] }) =>
      apiFetch<{ acceptUrl: string }>(`/v1/providers/${providerId}/delegations/invitation`, {
        method: "POST",
        tenantId,
        body: args,
      }),
    onSuccess: (result) => {
      reset();
      // Shown once. The email is the affordance, but the worker memoises its
      // provider at boot and one that cannot deliver writes SKIPPED rather than
      // a fake SENT — without this the owner has no recovery path at all
      // (phase-9-owner-onboarding-emails §2).
      setAcceptUrl(result.acceptUrl);
      invalidate();
    },
    onError: failed,
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
    onError: failed,
  });

  // An ADMIN reaches neither branch: they may edit this schedule and may not
  // see who else runs it.
  if (!canManage && !isOwnDiary) return null;

  const rows = delegations.data?.items ?? [];
  const available = (candidates.data?.items ?? []).filter((entry) => !entry.alreadyDelegated);
  const busy = save.isPending || invite.isPending || revoke.isPending;

  /**
   * Unticking the last scope is a revocation, not a grant of nothing — the
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
      current.includes(scope) ? current.filter((entry) => entry !== scope) : [...current, scope],
    );
  }

  function scopeLabel(scope: DelegationScope): string {
    return scope === "AVAILABILITY"
      ? t("delegateScopeAvailability")
      : t("delegateScopeBookings");
  }

  return (
    <Card
      title={providerName === undefined ? t("delegates") : t("delegatesFor", { name: providerName })}
      description={canManage ? t("delegatesHint") : t("delegatesHintProvider")}
      actions={
        <span className="flex gap-2">
          {canManage && mode === "idle" ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setMode("assign");
                  setError(null);
                  setAcceptUrl(null);
                }}
              >
                {t("delegateAdd")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setMode("invite");
                  setError(null);
                  setAcceptUrl(null);
                }}
              >
                {t("delegateInvite")}
              </Button>
            </>
          ) : null}
          {/* Only as a row panel. Inline on the availability screen there is
              nothing to close — the panel is the page. */}
          {onClose === undefined ? null : (
            <Button variant="secondary" onClick={onClose}>
              {t("delegateClose")}
            </Button>
          )}
        </span>
      }
      {...panelProps}
    >
      {error === null ? null : <ErrorText>{error}</ErrorText>}

      {acceptUrl === null ? null : (
        <Callout tone="action">
          <span className="flex flex-col gap-1">
            <span>{t("delegateInviteSent")}</span>
            <code className="text-xs break-all">{acceptUrl}</code>
            <span className="text-xs">{t("delegateInviteLinkOnce")}</span>
          </span>
        </Callout>
      )}

      {rows.length === 0 && mode === "idle" ? (
        // The day-2 trap (§6.5): a provider added after the migration has no
        // assistants and the front desk silently loses them. The provider's
        // version of the message asks them to go and ask, because they cannot
        // fix it themselves.
        <Callout tone="action">
          {canManage ? t("delegatesEmpty") : t("delegatesEmptyProvider")}
        </Callout>
      ) : null}

      {rows.length > 0 ? (
        <DataTable
          caption={t("delegates")}
          head={
            <tr>
              <Th>{t("delegateMember")}</Th>
              <Th>{t("delegateScopes")}</Th>
              {canManage ? (
                <Th>
                  <span className="sr-only">{t("delegateActions")}</span>
                </Th>
              ) : null}
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
                    // (§2.8). Surfaced where it can be fixed.
                    <Badge tone="warning" className="mt-1 self-start">
                      {t("delegateStaleRole")}
                    </Badge>
                  )}
                </span>
              </Td>
              <Td>
                {canManage ? (
                  <span className="flex flex-wrap gap-3">
                    {SCOPES.map((scope) => (
                      <label key={scope} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={row.scopes.includes(scope)}
                          disabled={busy}
                          onChange={() => {
                            toggleScope(row, scope);
                          }}
                        />
                        {scopeLabel(scope)}
                      </label>
                    ))}
                  </span>
                ) : (
                  // Read-only for the provider: text, not disabled checkboxes.
                  // A disabled control invites the reader to try to enable it.
                  <span className="text-sm">
                    {row.scopes.map((scope) => scopeLabel(scope)).join(" · ")}
                  </span>
                )}
              </Td>
              {canManage ? (
                <Td className="text-right">
                  <RowButton
                    disabled={busy}
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
              ) : null}
            </tr>
          ))}
        </DataTable>
      ) : null}

      {mode === "idle" ? null : (
        <div className="flex flex-col gap-3">
          {mode === "assign" ? (
            <>
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
            </>
          ) : (
            <TextField
              id="delegate-email"
              label={t("delegateEmail")}
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              className="max-w-sm"
            />
          )}

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
                  <span>{scopeLabel(scope)}</span>
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
              disabled={
                busy ||
                draftScopes.length === 0 ||
                (mode === "assign" ? candidateId === "" : email.trim() === "")
              }
              onClick={() => {
                if (draftScopes.length === 0) {
                  setError(t("delegateNeedsOneScope"));
                  return;
                }

                if (mode === "assign") {
                  save.mutate({ membershipId: candidateId, scopes: draftScopes });
                } else {
                  invite.mutate({ email: email.trim(), scopes: draftScopes });
                }
              }}
            >
              {mode === "assign" ? t("delegateGrant") : t("delegateSendInvite")}
            </Button>
            <Button variant="secondary" onClick={reset}>
              {t("delegateCancel")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
