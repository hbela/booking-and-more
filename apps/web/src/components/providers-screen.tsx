"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  ApiError,
  apiFetch,
  formatMoney,
  fromMinorUnits,
  toMinorUnits,
  type AssignedLocation,
  type AssignedService,
  type Invitation,
  type Location,
  type Member,
  type Paginated,
  type Provider,
  type ProviderInvitation,
  type Service,
} from "@/lib/api-client";
import {
  buildProviderLocationsBody,
  buildProviderServicesBody,
  optionalNumber,
  seedLocationRows,
  seedServiceRows,
  type LocationAssignmentRow,
  type ServiceAssignmentRow,
} from "@/lib/assignments";
import { diffPatch } from "@/lib/catalogue-form";
import {
  ProviderFields,
  providerBodyFrom,
  providerStateFrom,
  type ProviderFormState,
} from "./provider-fields";
import { DashboardShell, useDashboardContext, useSignInRedirect } from "./dashboard-shell";
import { NoOrganizationPanel } from "./no-organization";
import { ProviderDelegates } from "./provider-delegates";
import { type EditPanel, useEditPanel } from "@/lib/use-edit-panel";
import { Button } from "./ui/button";
import { Alert, AlertDescription, AlertLink } from "./ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { ErrorText, FormField } from "./ui/form-field";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Section } from "./ui/section";
import {
  RowButton,
  RowLink,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import { Checkbox } from "./ui/checkbox";

/** One node, shared by every disabled Invite button, so the reason is announced. */
const INVITE_HINT_ID = "provider-invite-needs-email";

/**
 * Providers screen. tech-impl §28.
 *
 * Controls appear only when `me.permissions` says the caller may use them —
 * which is a UI affordance and nothing more. Every action is authorised again
 * server-side, so hiding a button is never what stops an unauthorised call.
 */
export function ProvidersScreen(): React.ReactElement {
  const t = useTranslations("catalogue");
  const context = useDashboardContext();
  useSignInRedirect(!context.isPending && !context.me);
  const queryClient = useQueryClient();

  const assignments = useEditPanel("provider-assignments");
  const edit = useEditPanel("provider");
  const invite = useEditPanel("provider-invite");
  const assistants = useEditPanel("provider-assistants");
  const [showArchived, setShowArchived] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const canManage = context.can("provider:manage");
  // Staffing a diary is `delegation:manage`, which **only OWNER holds** — not
  // the ADMIN who may edit every schedule in the clinic
  // (docs/phase-3-4-diary-delegation.md §2.3). Deliberately a third permission
  // rather than reusing either of the two above: the gap in the ADMIN row is
  // the decision, and reading it as `provider:manage` would silently close it.
  const canDelegate = context.can("delegation:manage");
  const canChangeApproval = context.can("tenant:manage");
  // The invite button asks for the permission the *route* asks for, which is
  // not `provider:manage`: what it creates is an invitation granting a
  // membership, and the provider is only the object (phase-9-provider-onboarding
  // §3). Today every holder of one holds the other; that is not the point.
  const canInvite = context.can("member:manage");

  const providers = useQuery({
    queryKey: ["providers", context.tenantId, showArchived],
    queryFn: () =>
      apiFetch<Paginated<Provider>>(
        `/v1/providers?limit=100${showArchived ? "&includeArchived=true" : ""}`,
        { tenantId: context.tenantId },
      ),
    enabled: Boolean(context.tenantId),
  });

  const editing = providers.data?.items.find((provider) => provider.id === edit.openId);
  const inviting = providers.data?.items.find((provider) => provider.id === invite.openId);
  const staffing = providers.data?.items.find((provider) => provider.id === assistants.openId);

  // What a provider needs before they can be booked. Fetched here rather than
  // inside the assignment panel because the point is to say so *before* someone
  // creates a provider and wonders why nothing happens.
  const services = useQuery({
    queryKey: ["services", context.tenantId, false],
    queryFn: () =>
      apiFetch<Paginated<Service>>("/v1/services?limit=100", { tenantId: context.tenantId }),
    enabled: Boolean(context.tenantId),
  });

  const locations = useQuery({
    queryKey: ["locations", context.tenantId, false],
    queryFn: () =>
      apiFetch<Paginated<Location>>("/v1/locations?limit=100", { tenantId: context.tenantId }),
    enabled: Boolean(context.tenantId),
  });

  // So the button can offer "resend" rather than repeating "invite" at somebody
  // who already pressed it. Gated on member:read, which a PROVIDER holds and an
  // unprivileged caller does not.
  const invitations = useQuery({
    queryKey: ["invitations", context.tenantId],
    queryFn: () =>
      apiFetch<{ items: Invitation[] }>("/v1/members/invitations", { tenantId: context.tenantId }),
    enabled: Boolean(context.tenantId) && context.can("member:read"),
  });

  // Who signs in *as* each provider, so archiving one can say whose login it
  // takes away. Archiving keeps `Membership.providerId` but every availability
  // and booking endpoint 404s on an archived provider, so the person is left
  // signed in to a diary that answers "not found" — what happened on staging
  // on 2026-09-29, one click after three edits.
  const members = useQuery({
    queryKey: ["members", context.tenantId],
    queryFn: () => apiFetch<{ items: Member[] }>("/v1/members", { tenantId: context.tenantId }),
    enabled: Boolean(context.tenantId) && context.can("member:read"),
  });

  const loginFor = (providerId: string): Member | undefined =>
    (members.data?.items ?? []).find(
      (member) => member.providerId === providerId && member.status === "ACTIVE",
    );

  // "This is me": the owner — or an administrator — who also treats patients
  // claims a diary that was created under another address
  // (docs/phase-9-owner-as-provider.md §2.3). Offered only to somebody who
  // holds no diary yet and whose role can use one; asked as a permission rather
  // than a role (rule 10). The PATCH is the caller's own membership, which the
  // route allows because a link grants a subset of what they already hold.
  const myMembership = context.me?.membership ?? null;
  const canClaimDiary =
    canInvite &&
    context.can("availability:manage:own") &&
    myMembership !== null &&
    myMembership.providerId === null;
  const [claimError, setClaimError] = useState<string | null>(null);

  const claimDiary = useMutation({
    mutationFn: (provider: Provider) =>
      apiFetch(`/v1/members/${myMembership?.id ?? ""}`, {
        method: "PATCH",
        tenantId: context.tenantId,
        body: { providerId: provider.id },
      }),
    onMutate: () => {
      setClaimError(null);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["members"] });
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (cause: unknown) => {
      setClaimError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  const changeApproval = useMutation({
    mutationFn: (provider: Provider) =>
      apiFetch<Provider>(`/v1/providers/${provider.id}/booking-approval`, {
        method: "PATCH",
        tenantId: context.tenantId,
        body: { automatic: !provider.autoConfirmBookings },
      }),
    onMutate: () => {
      setApprovalError(null);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
    onError: (cause: unknown) => {
      setApprovalError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  const invitedProviderIds = new Set(
    (invitations.data?.items ?? [])
      .map((invitation) => invitation.providerId)
      .filter((id): id is string => id !== null),
  );

  const noServices = services.isSuccess && services.data.items.length === 0;
  const noLocations = locations.isSuccess && locations.data.items.length === 0;

  // Only legacy rows: both write schemas have required an address since
  // phase-2-3 §2.8. Rendered once under the table rather than per row.
  const anyWithoutEmail = (providers.data?.items ?? []).some(
    (provider) => provider.archivedAt === null && provider.email === null,
  );

  // A signed-out visitor is redirected from an effect, not from render.
  if (context.isPending || !context.me) {
    return <p className="p-8">{t("loading")}</p>;
  }

  // Signed in, but there is no organization to scope this screen to. Every
  // query below is gated on `context.tenantId`, so without this the shell
  // renders around a body that never fills (see no-organization.tsx).
  if (context.hasNoOrganization) {
    return (
      <DashboardShell context={context}>
        <NoOrganizationPanel isPlatformAdmin={context.me.user.isPlatformAdmin} />
      </DashboardShell>
    );
  }

  return (
    <DashboardShell context={context}>
      <Section title={t("providers")}>
        {/* A provider with no service to offer cannot be booked at all, so this
            is a real prerequisite rather than a suggestion. */}
        {noServices ? (
          <Alert variant="warning">
            <AlertDescription>
              {t.rich("needServicesFirst", {
                link: (chunks) => <AlertLink href="/dashboard/services">{chunks}</AlertLink>,
              })}
            </AlertDescription>
          </Alert>
        ) : null}

        {/* Locations are genuinely optional — slot search never requires one, so
            an online-only or telephone practice is bookable without any. Said
            plainly, rather than dressed up as a second blocker. */}
        {noLocations ? (
          <Alert>
            <AlertDescription>
              {t.rich("noLocationsYet", {
                link: (chunks) => <AlertLink href="/dashboard/locations">{chunks}</AlertLink>,
              })}
            </AlertDescription>
          </Alert>
        ) : null}

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={showArchived}
            onCheckedChange={(value) => {
              setShowArchived(value === true);
            }}
          />
          <span>{t("showArchived")}</span>
        </label>

        {providers.data?.items.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("noProviders")}</p>
        ) : (
          <Table className="w-full min-w-md">
            <TableHeader>
              <TableRow>
                <TableHead>{t("name")}</TableHead>
                <TableHead>{t("timezone")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead>{t("approval")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.data?.items.map((provider) => {
                const archived = provider.archivedAt !== null;

                return (
                  <TableRow key={provider.id}>
                    <TableCell className={archived ? "text-ink-subtle" : undefined}>
                      {provider.displayName}
                      {myMembership?.providerId === provider.id ? (
                        <span className="text-ink-subtle"> · {t("thisIsYou")}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-ink-muted">{provider.timezone}</TableCell>
                    <TableCell>
                      {archived ? t("archived") : provider.active ? t("active") : t("inactive")}
                      {archived || provider.onlineBookingEnabled ? "" : ` · ${t("offlineOnly")}`}
                    </TableCell>
                    <TableCell className="text-ink-muted">
                      {provider.autoConfirmBookings ? t("approvalAutomatic") : t("approvalManual")}
                    </TableCell>
                    <TableCell>
                      {!canManage ? null : archived ? (
                        <RowButton
                          onClick={() => {
                            void apiFetch(`/v1/providers/${provider.id}/restore`, {
                              method: "POST",
                              tenantId: context.tenantId,
                            }).then(() => {
                              void queryClient.invalidateQueries({ queryKey: ["providers"] });
                            });
                          }}
                        >
                          {t("restore")}
                        </RowButton>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          <RowButton
                            onClick={() => {
                              edit.toggle(provider.id);
                            }}
                            {...edit.triggerProps(provider.id)}
                          >
                            {t("edit")}
                          </RowButton>
                          <RowButton
                            onClick={() => {
                              assignments.toggle(provider.id);
                            }}
                            {...assignments.triggerProps(provider.id)}
                          >
                            {t("assign")}
                          </RowButton>
                          {/* Availability hangs off the provider rather than
                                off the nav: it is this person's diary, and
                                theirs to set (§2.7). The owner reaches it one
                                provider at a time, which is also the only way
                                to say *whose* diary is being opened. */}
                          <RowLink href={`/dashboard/availability?providerId=${provider.id}`}>
                            {t("availability")}
                          </RowLink>
                          {!canChangeApproval ? null : (
                            <RowButton
                              disabled={changeApproval.isPending}
                              onClick={() => {
                                changeApproval.mutate(provider);
                              }}
                            >
                              {provider.autoConfirmBookings
                                ? t("switchToManualApproval")
                                : t("switchToAutomaticApproval")}
                            </RowButton>
                          )}
                          {/* Giving this person a login. One action, because
                                the two it replaced — invite, then link the
                                membership to the diary — lived on different
                                screens and the second was never built
                                (phase-9-provider-onboarding §1). */}
                          {canClaimDiary && loginFor(provider.id) === undefined ? (
                            <RowButton
                              disabled={claimDiary.isPending}
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    t("claimDiaryConfirm", { name: provider.displayName }),
                                  )
                                ) {
                                  return;
                                }
                                claimDiary.mutate(provider);
                              }}
                            >
                              {t("claimDiary")}
                            </RowButton>
                          ) : null}
                          {/* A diary somebody already signs in as needs no
                                invitation — the API would only refuse it. That
                                includes the owner's own (§2.2). */}
                          {!canInvite ||
                          loginFor(provider.id) !== undefined ? null : provider.email === null ? (
                            // aria-disabled on a live button rather than
                            // `disabled`, so a keyboard user still reaches it
                            // and hears why. Same reasoning as the nav's
                            // subscription gate.
                            <RowButton
                              onClick={() => {
                                /* no address to invite */
                              }}
                              aria-disabled="true"
                              aria-describedby={INVITE_HINT_ID}
                              className="border-line-strong text-ink-subtle rounded-md border px-2 py-1 text-xs"
                            >
                              {t("invite")}
                            </RowButton>
                          ) : (
                            <RowButton
                              onClick={() => {
                                invite.toggle(provider.id);
                              }}
                              {...invite.triggerProps(provider.id)}
                            >
                              {invitedProviderIds.has(provider.id) ? t("reinvite") : t("invite")}
                            </RowButton>
                          )}
                          <RowButton
                            onClick={() => {
                              void apiFetch(`/v1/providers/${provider.id}`, {
                                method: "PATCH",
                                tenantId: context.tenantId,
                                body: { active: !provider.active },
                              }).then(() => {
                                void queryClient.invalidateQueries({ queryKey: ["providers"] });
                              });
                            }}
                          >
                            {provider.active ? t("deactivate") : t("activate")}
                          </RowButton>
                          {/* Who assists on this diary. The panel already
                                existed, at the foot of the availability screen,
                                which put staffing behind "open their diary and
                                scroll" — and made it read as an availability
                                setting rather than as who works here. This is
                                the owner's route to it: same component, same
                                rules, reached from the row that names the
                                person. */}
                          {!canDelegate ? null : (
                            <RowButton
                              onClick={() => {
                                assistants.toggle(provider.id);
                              }}
                              {...assistants.triggerProps(provider.id)}
                            >
                              {t("manageAssistant")}
                            </RowButton>
                          )}
                          <RowButton
                            onClick={() => {
                              const login = loginFor(provider.id);
                              const question = login
                                ? t("archiveConfirmLinked", {
                                    name: provider.displayName,
                                    email: login.user.email,
                                  })
                                : t("archiveConfirm", { name: provider.displayName });
                              if (!window.confirm(question)) return;

                              void apiFetch(`/v1/providers/${provider.id}`, {
                                method: "DELETE",
                                tenantId: context.tenantId,
                              }).then(() => {
                                void queryClient.invalidateQueries({ queryKey: ["providers"] });
                              });
                            }}
                          >
                            {t("archive")}
                          </RowButton>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {/* The linking step is a row action, which made it easy to miss: an
            owner could create services and providers and still have no idea what
            joins them. Naming it here is the cheapest fix. */}
        {(providers.data?.items.length ?? 0) > 0 && !noServices ? (
          <Alert>
            <AlertDescription>{t("assignHint")}</AlertDescription>
          </Alert>
        ) : null}

        {(providers.data?.items.length ?? 0) > 0 ? (
          <Alert>
            <AlertDescription>{t("approvalHint")}</AlertDescription>
          </Alert>
        ) : null}

        <ErrorText>{approvalError}</ErrorText>
        <ErrorText>{claimError}</ErrorText>

        {/* One node, referenced by every disabled Invite button, so the reason
            is announced rather than left to be guessed from a grey button. */}
        {canInvite && anyWithoutEmail ? (
          <p id={INVITE_HINT_ID} className="text-xs text-ink-subtle">
            {t("inviteNeedsEmail")}
          </p>
        ) : null}
      </Section>

      {editing && context.tenantId ? (
        <EditProviderPanel
          key={`edit-${editing.id}`}
          tenantId={context.tenantId}
          provider={editing}
          panelProps={edit.panelProps}
          onClose={edit.close}
        />
      ) : null}

      {assignments.openId && context.tenantId ? (
        <AssignmentsPanel
          tenantId={context.tenantId}
          providerId={assignments.openId}
          panelProps={assignments.panelProps}
          onClose={assignments.close}
        />
      ) : null}

      {/* Include the panel type because multiple panels can be open for the
          same provider. The provider id still resets the form on row changes. */}
      {staffing && context.tenantId ? (
        <ProviderDelegates
          key={`assistants-${staffing.id}`}
          tenantId={context.tenantId}
          providerId={staffing.id}
          providerName={staffing.displayName}
          panelProps={assistants.panelProps}
          onClose={assistants.close}
        />
      ) : null}

      {inviting && context.tenantId ? (
        <InvitePanel
          key={`invite-${inviting.id}`}
          tenantId={context.tenantId}
          provider={inviting}
          alreadyInvited={invitedProviderIds.has(inviting.id)}
          panelProps={invite.panelProps}
          onClose={invite.close}
        />
      ) : null}

      {canManage && canInvite && context.tenantId ? (
        <CreateProviderPanel
          tenantId={context.tenantId}
          services={services.data?.items}
          locations={locations.data?.items}
        />
      ) : null}
    </DashboardShell>
  );
}

/**
 * Giving one provider a login.
 * docs/phase-9-provider-onboarding.md §2.
 *
 * A `useEditPanel` rather than a `confirm()`: this screen has no Dialog
 * primitive and is not getting one, and the hook already carries the focus
 * wiring, the `aria-expanded`/`aria-controls` pairing and the scroll behaviour.
 *
 * There is nothing to fill in. The address comes from the provider record and
 * the role is always PROVIDER, so the whole form is one button and the text
 * that says what pressing it will do — which is the point: an owner should be
 * able to see who is about to be emailed before emailing them.
 */
function InvitePanel({
  tenantId,
  provider,
  alreadyInvited,
  panelProps,
  onClose,
}: {
  tenantId: string;
  provider: Provider;
  alreadyInvited: boolean;
  panelProps: EditPanel["panelProps"];
  onClose: () => void;
}): React.ReactElement {
  const t = useTranslations("catalogue");
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<ProviderInvitation | null>(null);

  const send = useMutation({
    mutationFn: () =>
      apiFetch<ProviderInvitation>(`/v1/providers/${provider.id}/invitation`, {
        method: "POST",
        tenantId,
      }),
    onSuccess: (invitation) => {
      setSent(invitation);
      // The invitation list changed, and so did the member list once they
      // accept. Not ["providers"] — nothing on the row moved.
      void queryClient.invalidateQueries({ queryKey: ["invitations"] });
      void queryClient.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (cause: unknown) => {
      // The API's 409s and 422 are already written to be read by an owner —
      // "another member already holds this diary", "add an email first" — so
      // they are shown as they arrive rather than flattened into one message.
      setError(cause instanceof ApiError ? cause.message : t("inviteFailed"));
    },
  });

  return (
    <Card {...panelProps}>
      <CardHeader>
        <CardTitle>{t("inviteTitle", { name: provider.displayName })}</CardTitle>
      </CardHeader>
      <CardContent>
        {sent ? (
          <div className="flex flex-col gap-3">
            <p role="status" className="text-sm">
              {t("inviteSent", { email: sent.email })}
            </p>

            {/* Collapsed, deliberately. The email is the mechanism; this is the
              escape hatch for the case where the worker booted without a mail
              key and wrote SKIPPED rather than a fake SENT
              (phase-9-owner-onboarding-emails §2). Shown once — only a hash of
              the token is stored, so it cannot be recovered afterwards. */}
            <details>
              <summary className="cursor-pointer text-xs text-ink-muted">
                {t("inviteLinkFallback")}
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                <p className="text-xs text-ink-subtle">{t("inviteLinkOnceHint")}</p>
                <Input
                  readOnly
                  value={sent.acceptUrl}
                  aria-label={t("inviteLinkFallback")}
                  onFocus={(event) => {
                    event.currentTarget.select();
                  }}
                />
              </div>
            </details>

            <Button variant="outline" type="button" onClick={onClose}>
              {t("close")}
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              send.mutate();
            }}
          >
            <p className="text-sm text-ink-muted">
              {t("inviteIntro", { email: provider.email ?? "" })}
            </p>
            <p className="text-sm text-ink-muted">{t("inviteWhatTheyGet")}</p>

            {/* Said before the press, not after: re-inviting silently kills the
              link the first email carried, and somebody halfway through using
              it deserves to be the owner's decision rather than a surprise. */}
            {alreadyInvited ? (
              <Alert>
                <AlertDescription>{t("alreadyInvited")}</AlertDescription>
              </Alert>
            ) : null}

            <ErrorText>{error}</ErrorText>

            <div className="flex gap-3">
              <Button type="submit" disabled={send.isPending}>
                {alreadyInvited ? t("reinvite") : t("sendInvitation")}
              </Button>
              <Button variant="outline" type="button" onClick={onClose}>
                {t("cancel")}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The provider was created; only the linking failed.
 *
 * A distinct type because the two failures need different words: the generic
 * message would have an owner retry a creation that already succeeded.
 */
class AssignmentFailed extends Error {
  constructor(cause: unknown) {
    super("provider created, assignment failed", { cause });
  }
}

/**
 * Creating a provider, including what they offer and where they are based.
 *
 * Both pickers are here and not only behind the row's Assign button because the
 * dependency runs the other way round: a provider with no service cannot be
 * booked at all (§3.3), so the screen asked owners to create something that did
 * nothing and then discover a second step. Assign keeps its job — it is where
 * per-provider durations, prices, pausing and *additional* locations live, and
 * this form deliberately offers none of those.
 *
 * ## Why the location is one and the services are many
 *
 * They are different questions. A provider offers a set of services; a provider
 * is *based* somewhere. The owner sets that base — the location this provider
 * normally works at — and everything after it belongs to the provider: when they
 * work, at which of the organization's locations, for which service. That is
 * decided on the availability screen, by the provider, and a working-hours row
 * already carries its own `locationId` to say so.
 *
 * So this is a single select, and it writes exactly one `provider_locations`
 * row. Not choosing one is a real answer, not a skipped field: an online-only or
 * telephone practice has no base to name, and slot search never requires a
 * location.
 *
 * Both assignments are separate requests because `POST /v1/providers` takes
 * neither: it cannot be one transaction, so the failure is named rather than
 * hidden.
 */
function CreateProviderPanel({
  tenantId,
  services,
  locations,
}: {
  tenantId: string;
  services: Service[] | undefined;
  locations: Location[] | undefined;
}): React.ReactElement {
  const t = useTranslations("catalogue");
  const queryClient = useQueryClient();
  const [state, setState] = useState<ProviderFormState>(() => providerStateFrom());
  const [error, setError] = useState<string | null>(null);

  // One row per live service, all unticked: a provider that does not exist yet
  // has no assignments to read, so unlike the edit panel there is no whole-set
  // read to lose (§2). Null until the list arrives.
  const [serviceRows, setServiceRows] = useState<Map<string, ServiceAssignmentRow> | null>(null);

  // "" means "no base location", which is a real answer — see the doc comment.
  const [defaultLocationId, setDefaultLocationId] = useState("");

  useEffect(() => {
    if (!services) return;

    // Ticks already made survive a background refetch of the service list —
    // rebuilding from scratch would silently untick a form mid-fill.
    setServiceRows((current) => {
      const next = new Map<string, ServiceAssignmentRow>();
      for (const service of services) {
        next.set(
          service.id,
          current?.get(service.id) ?? {
            checked: false,
            customDurationMinutes: null,
            customPriceMinor: null,
            active: true,
          },
        );
      }
      return next;
    });
  }, [services]);

  const mutation = useMutation({
    mutationFn: async () => {
      const provider = await apiFetch<Provider & { onboarding: "INVITED" | "LINKED" }>(
        "/v1/providers",
        {
          method: "POST",
          tenantId,
          body: providerBodyFrom(state, "create"),
        },
      );

      const services =
        serviceRows === null ? { services: [] } : buildProviderServicesBody(serviceRows);
      // One row, or none. Built through the same builder as the edit panel so
      // there is one shape of this body and not two (§2).
      const locations = buildProviderLocationsBody(
        defaultLocationId === ""
          ? new Map()
          : new Map([[defaultLocationId, { checked: true, active: true }]]),
      );

      try {
        if (services.services.length > 0) {
          await apiFetch(`/v1/providers/${provider.id}/services`, {
            method: "PUT",
            tenantId,
            body: services,
          });
        }

        if (locations.locations.length > 0) {
          await apiFetch(`/v1/providers/${provider.id}/locations`, {
            method: "PUT",
            tenantId,
            body: locations,
          });
        }
      } catch (cause) {
        throw new AssignmentFailed(cause);
      }

      return provider.onboarding;
    },
    onSuccess: () => {
      setState(providerStateFrom());
      setServiceRows(
        (current) =>
          current &&
          new Map([...current].map(([id, row]) => [id, { ...row, checked: false }] as const)),
      );
      setDefaultLocationId("");
      void queryClient.invalidateQueries({ queryKey: ["invitations", tenantId] });
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      void queryClient.invalidateQueries({ queryKey: ["provider-services"] });
      void queryClient.invalidateQueries({ queryKey: ["provider-locations"] });
    },
    onError: (cause: unknown) => {
      if (cause instanceof AssignmentFailed) {
        void queryClient.invalidateQueries({ queryKey: ["invitations", tenantId] });
        // The provider list is stale either way — it gained a row.
        void queryClient.invalidateQueries({ queryKey: ["providers"] });
        setError(t("createdButNotAssigned"));
        return;
      }

      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("addProvider")}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-ink-muted">{t("addProviderHint")}</p>
        {/* Linked rather than invited when the address is a member's own — the
          owner who also treats patients (docs/phase-9-owner-as-provider.md
          §2.2). Saying "invited" there would send them looking for an email. */}
        {mutation.isSuccess ? (
          <p role="status">
            {mutation.data === "LINKED"
              ? t("providerCreatedAndLinked")
              : t("providerCreatedAndInvited")}
          </p>
        ) : null}

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            mutation.mutate();
          }}
        >
          <ProviderFields
            state={state}
            idPrefix="new-provider"
            onChange={(patch) => {
              setState((current) => ({ ...current, ...patch }));
            }}
          />

          {/* Absent when there are none: the amber notice at the top of the screen
            already says to create a service first, and an empty fieldset here
            would only repeat it. */}
          {services && services.length > 0 && serviceRows ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">{t("services")}</legend>
              {services.map((service) => (
                <label key={service.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={serviceRows.get(service.id)?.checked ?? false}
                    onCheckedChange={(value) => {
                      const checked = value === true;
                      setServiceRows((current) => {
                        const existing = current?.get(service.id);
                        if (!current || !existing) return current;

                        const next = new Map(current);
                        next.set(service.id, { ...existing, checked });
                        return next;
                      });
                    }}
                  />
                  <span>
                    {service.name}
                    <span className="text-ink-subtle">
                      {" · "}
                      {t("minutes", { count: service.durationMinutes })}
                    </span>
                  </span>
                </label>
              ))}
              <p className="text-xs text-ink-subtle">{t("assignOnCreateHint")}</p>
            </fieldset>
          ) : null}

          {/* A select and not a checkbox list: this is where the provider is
            based, not everywhere they may ever work. The blank option is kept
            selectable rather than being a placeholder that disappears — "no
            base location" is a state an owner may want to return to. */}
          {locations && locations.length > 0 ? (
            <>
              <FormField id="new-provider-location" label={t("defaultLocation")}>
                <NativeSelect
                  id="new-provider-location"
                  value={defaultLocationId}
                  onChange={(event) => {
                    setDefaultLocationId(event.target.value);
                  }}
                >
                  <option value="">{t("noDefaultLocation")}</option>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <p className="text-xs text-ink-subtle">{t("defaultLocationHint")}</p>
            </>
          ) : null}

          <ErrorText>{error}</ErrorText>

          <Button type="submit" disabled={mutation.isPending}>
            {t("create")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Editing a provider. Sends a diff — see {@link diffPatch}. */
function EditProviderPanel({
  tenantId,
  provider,
  panelProps,
  onClose,
}: {
  tenantId: string;
  provider: Provider;
  panelProps: EditPanel["panelProps"];
  onClose: () => void;
}): React.ReactElement {
  const t = useTranslations("catalogue");
  const queryClient = useQueryClient();

  const original = providerStateFrom(provider);
  const [state, setState] = useState<ProviderFormState>(original);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      apiFetch<Provider>(`/v1/providers/${provider.id}`, {
        method: "PATCH",
        tenantId,
        body: diffPatch(providerBodyFrom(original, "patch"), providerBodyFrom(state, "patch")),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
      onClose();
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  return (
    <Card {...panelProps}>
      <CardHeader>
        <CardTitle>{t("editProvider")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          <ProviderFields
            state={state}
            idPrefix={`edit-provider-${provider.id}`}
            onChange={(patch) => {
              setState((current) => ({ ...current, ...patch }));
            }}
          />

          <ErrorText>{error}</ErrorText>

          <div className="flex gap-3">
            <Button type="submit" disabled={save.isPending}>
              {t("saveChanges")}
            </Button>
            <Button variant="outline" type="button" onClick={onClose}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Service and location assignment, plus the per-provider overrides.
 *
 * ## Why this is controlled state and not a `FormData` read
 *
 * Both `PUT`s replace the whole set, so a field this panel fails to send back is
 * a field deleted on the server. Reading the checkboxes out of `FormData` at
 * submit time can only ever recover the ids, which is how the first version
 * silently destroyed every `customDurationMinutes`, `customPriceMinor` and
 * paused assignment on each save.
 *
 * So the rows are loaded, held in state, edited in place, and written back
 * whole. Two consequences worth stating, because both were separate bugs:
 *
 *  - Nothing renders until all four queries have resolved. Uncontrolled
 *    `defaultChecked` seeded from a pending query paints every box unticked and
 *    never re-syncs, so opening the panel and saving quickly unassigned
 *    everything.
 *  - A box is ticked when an assignment *exists*, not when it is active. Those
 *    are different questions, and conflating them deleted paused assignments.
 *
 * The body builders live in `@/lib/assignments` and are unit-tested there.
 */
function AssignmentsPanel({
  tenantId,
  providerId,
  panelProps,
  onClose,
}: {
  tenantId: string;
  providerId: string;
  panelProps: EditPanel["panelProps"];
  onClose: () => void;
}): React.ReactElement {
  const t = useTranslations("catalogue");
  const locale = useLocale();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  // Null until seeded, rather than an empty Map. An empty Map is a *valid* set
  // meaning "offers nothing", so it cannot double as "not loaded yet" — and the
  // gap between a resolved query and the effect that seeds from it is a real
  // paint, during which Save would have submitted it and deleted everything.
  const [serviceRows, setServiceRows] = useState<Map<string, ServiceAssignmentRow> | null>(null);
  const [locationRows, setLocationRows] = useState<Map<string, LocationAssignmentRow> | null>(null);

  const services = useQuery({
    queryKey: ["services", tenantId],
    queryFn: () => apiFetch<Paginated<Service>>("/v1/services?limit=100", { tenantId }),
  });

  const locations = useQuery({
    queryKey: ["locations", tenantId],
    queryFn: () => apiFetch<Paginated<Location>>("/v1/locations?limit=100", { tenantId }),
  });

  const assignedServices = useQuery({
    queryKey: ["provider-services", providerId],
    queryFn: () =>
      apiFetch<{ items: AssignedService[] }>(`/v1/providers/${providerId}/services`, { tenantId }),
  });

  const assignedLocations = useQuery({
    queryKey: ["provider-locations", providerId],
    queryFn: () =>
      apiFetch<{ items: AssignedLocation[] }>(`/v1/providers/${providerId}/locations`, {
        tenantId,
      }),
  });

  // Both halves of each pair have to be present before the rows mean anything:
  // the catalogue decides which rows exist, the assignments decide what they
  // hold.
  const serviceData = services.data;
  const assignedServiceData = assignedServices.data;
  useEffect(() => {
    if (!serviceData || !assignedServiceData) return;

    setServiceRows(
      seedServiceRows({ services: serviceData.items, assigned: assignedServiceData.items }),
    );
  }, [serviceData, assignedServiceData]);

  const locationData = locations.data;
  const assignedLocationData = assignedLocations.data;
  useEffect(() => {
    if (!locationData || !assignedLocationData) return;

    setLocationRows(
      seedLocationRows({ locations: locationData.items, assigned: assignedLocationData.items }),
    );
  }, [locationData, assignedLocationData]);

  // Seeded rows are the readiness signal, not the queries: they are what the
  // body is built from, so anything else leaves a window where it is not.
  const ready = serviceRows !== null && locationRows !== null;

  const save = useMutation({
    mutationFn: async () => {
      if (serviceRows === null || locationRows === null) {
        throw new Error("unreachable: the form does not render until both are seeded");
      }

      await apiFetch(`/v1/providers/${providerId}/services`, {
        method: "PUT",
        tenantId,
        body: buildProviderServicesBody(serviceRows),
      });

      await apiFetch(`/v1/providers/${providerId}/locations`, {
        method: "PUT",
        tenantId,
        body: buildProviderLocationsBody(locationRows),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["provider-services"] });
      void queryClient.invalidateQueries({ queryKey: ["provider-locations"] });
      onClose();
    },
    onError: (cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : t("genericError"));
    },
  });

  function updateService(serviceId: string, patch: Partial<ServiceAssignmentRow>): void {
    setServiceRows((current) => {
      const existing = current?.get(serviceId);
      if (!current || !existing) return current;

      const next = new Map(current);
      next.set(serviceId, { ...existing, ...patch });
      return next;
    });
  }

  function updateLocation(locationId: string, patch: Partial<LocationAssignmentRow>): void {
    setLocationRows((current) => {
      const existing = current?.get(locationId);
      if (!current || !existing) return current;

      const next = new Map(current);
      next.set(locationId, { ...existing, ...patch });
      return next;
    });
  }

  return (
    <Card {...panelProps}>
      <CardHeader>
        <CardTitle>{t("assignments")}</CardTitle>
      </CardHeader>
      <CardContent>
        {!ready ? (
          <p className="text-sm text-ink-muted">{t("loadingAssignments")}</p>
        ) : (
          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              save.mutate();
            }}
          >
            <fieldset className="flex flex-col gap-3">
              <legend className="text-sm font-medium">{t("services")}</legend>
              {services.data?.items.length === 0 ? (
                <Alert variant="warning">
                  <AlertDescription>
                    {t.rich("needServicesFirst", {
                      link: (chunks) => <AlertLink href="/dashboard/services">{chunks}</AlertLink>,
                    })}
                  </AlertDescription>
                </Alert>
              ) : (
                services.data?.items.map((service) => {
                  const row = serviceRows?.get(service.id);
                  if (!row) return null;

                  return (
                    <div key={service.id} className="flex flex-col gap-1">
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={row.checked}
                          onCheckedChange={(value) => {
                            updateService(service.id, { checked: value === true });
                          }}
                        />
                        <span>
                          {service.name}
                          <span className="text-ink-subtle">
                            {" · "}
                            {t("minutes", { count: service.durationMinutes })}
                          </span>
                        </span>
                      </label>

                      {row.checked ? (
                        <ServiceOverrides
                          service={service}
                          row={row}
                          locale={locale}
                          onChange={(patch) => {
                            updateService(service.id, patch);
                          }}
                        />
                      ) : null}
                    </div>
                  );
                })
              )}
            </fieldset>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">{t("locations")}</legend>
              {locations.data?.items.length === 0 ? (
                <Alert>
                  <AlertDescription>
                    {t.rich("noLocationsYet", {
                      link: (chunks) => <AlertLink href="/dashboard/locations">{chunks}</AlertLink>,
                    })}
                  </AlertDescription>
                </Alert>
              ) : (
                locations.data?.items.map((location) => {
                  const row = locationRows?.get(location.id);
                  if (!row) return null;

                  return (
                    <label key={location.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={row.checked}
                        onCheckedChange={(value) => {
                          updateLocation(location.id, { checked: value === true });
                        }}
                      />
                      <span>{location.name}</span>
                    </label>
                  );
                })
              )}
            </fieldset>

            <ErrorText>{error}</ErrorText>

            <div className="flex gap-3">
              <Button type="submit" disabled={save.isPending}>
                {t("save")}
              </Button>
              <Button variant="outline" type="button" onClick={onClose}>
                {t("cancel")}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * What this provider charges and how long they take, when it differs from the
 * service's own answer (phase-2 §5.4 — the API has always supported these).
 *
 * A `<details>` rather than a dialog: there is no Dialog primitive here, and the
 * native element is keyboard-operable and screen-reader-announced with no ARIA
 * of our own. It also keeps "does this provider offer X" and "on what terms"
 * next to each other, because they are one decision.
 *
 * Open by default when an override already exists — a customisation hidden
 * behind a closed twisty is a customisation nobody knows about.
 */
function ServiceOverrides({
  service,
  row,
  locale,
  onChange,
}: {
  service: Service;
  row: ServiceAssignmentRow;
  locale: string;
  onChange: (patch: Partial<ServiceAssignmentRow>) => void;
}): React.ReactElement {
  const t = useTranslations("catalogue");

  const customised =
    row.customDurationMinutes !== null || row.customPriceMinor !== null || !row.active;

  // `customPriceMinor` has no currency column of its own — it inherits the
  // service's. A custom price on a "price on request" service would therefore be
  // an amount in an unknown currency, which nothing could render, so the field
  // is not offered at all.
  const currency = service.currency;

  return (
    <details open={customised} className="ml-6">
      <summary className="cursor-pointer text-xs text-ink-muted">{t("customise")}</summary>

      <div className="mt-2 flex flex-col gap-2 border-l border-line pl-3">
        <FormField id={`duration-${service.id}`} label={t("customDuration")}>
          <Input
            id={`duration-${service.id}`}
            type="number"
            min={5}
            max={1440}
            step={5}
            value={row.customDurationMinutes ?? ""}
            onChange={(event) => {
              onChange({ customDurationMinutes: optionalNumber(event.target.value) });
            }}
            placeholder={String(service.durationMinutes)}
            className="w-32"
          />
        </FormField>
        <p className="text-xs text-ink-subtle">
          {t("inheritsDuration", { count: service.durationMinutes })}
        </p>

        {currency === null || service.priceMinor === null ? (
          <p className="text-xs text-ink-subtle">{t("priceOverrideNeedsBasePrice")}</p>
        ) : (
          <>
            <FormField id={`price-${service.id}`} label={`${t("customPrice")} (${currency})`}>
              <Input
                id={`price-${service.id}`}
                type="number"
                min={0}
                step="0.01"
                value={
                  row.customPriceMinor === null
                    ? ""
                    : fromMinorUnits(row.customPriceMinor, currency)
                }
                onChange={(event) => {
                  const amount = optionalNumber(event.target.value);
                  onChange({
                    customPriceMinor: amount === null ? null : toMinorUnits(amount, currency),
                  });
                }}
                className="w-32"
              />
            </FormField>
            <p className="text-xs text-ink-subtle">
              {t("inheritsPrice", { price: formatMoney(service.priceMinor, currency, locale) })}
            </p>
          </>
        )}

        {/* The *assignment's* active flag, not the service's. This is the one the
            previous editor destroyed on every save. */}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={row.active}
            onCheckedChange={(value) => {
              onChange({ active: value === true });
            }}
          />
          <span>{t("assignmentActive")}</span>
        </label>
      </div>
    </details>
  );
}
