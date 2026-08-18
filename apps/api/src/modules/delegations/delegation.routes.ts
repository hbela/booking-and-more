import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { Permissions, canReadProviderDelegates } from "@bam/auth";
import { ForbiddenError, buildAppUrl, commonErrorResponses, idSchema } from "@bam/contracts";
import { MembershipService } from "../memberships/membership.service.js";
import { ProviderService } from "../providers/provider.service.js";
import { DelegationService, toDelegationResponse } from "./delegation.service.js";
import {
  delegationCandidateSchema,
  delegationResponseSchema,
  inviteDelegateBodySchema,
  inviteDelegateResponseSchema,
  myDelegationSchema,
  setDelegationBodySchema,
} from "./delegation.schemas.js";

/**
 * Diary delegation. docs/phase-3-4-diary-delegation.md §5.1.
 *
 * ## Why the write surface hangs off the provider
 *
 * The diary is the resource being granted — the same reason working hours hang
 * off `/v1/providers/:providerId/`. A top-level `/v1/delegations` would have to
 * carry the provider id in the body, which makes "may I edit this?" a
 * body-dependent question and moves the tenant check away from the route that
 * needs it.
 *
 * ## Who may do what here
 *
 * **Writing is the owner's, and only the owner's** — `delegation:manage`, which
 * ADMIN deliberately does not hold despite holding `availability:manage:all`
 * (§2.3). It is a plain route guard rather than a per-resource check, because
 * the question has one answer for the whole organization: staffing is not a
 * property of a diary.
 *
 * **Reading is wider by exactly one person**: the provider whose diary it is,
 * who does not choose their assistants and must still be able to see who has
 * been given their week. That answer *does* depend on the id in the URL, so it
 * is `canReadProviderDelegates` in the handler — the same split
 * availability.routes.ts uses.
 *
 * Re-delegation needs no special case: an ASSISTANT holds no
 * `delegation:manage`, so a delegate cannot pass a diary on.
 */
export interface ProviderDelegationRoutesOptions {
  invitationExpiryHours: number;
  appBaseUrl: string;
}

export const providerDelegationRoutes: FastifyPluginAsyncZod<
  ProviderDelegationRoutesOptions
> = async (app, options) => {
  const service = new DelegationService(app.prisma);
  // Invitations are the membership module's business, including this one — the
  // same split provider.routes.ts uses for the provider's own link. This
  // module's job is the rule-5 lookup that proves the diary is in this tenant.
  const memberships = new MembershipService(app.prisma);
  const providers = new ProviderService(app.prisma).repository;

  /** 403 unless the actor may see who runs this particular diary. */
  function assertMayRead(request: FastifyRequest, providerId: string): void {
    const tenant = request.tenant!;
    const actor = request.actor as Parameters<typeof canReadProviderDelegates>[0];

    if (!canReadProviderDelegates(actor, tenant.id, providerId)) {
      // Deliberately not "that is not your diary", matching the availability
      // module: the caller learns only that they may not, never whose it is.
      throw new ForbiddenError("You do not have permission to view this provider's assistants.");
    }
  }

  app.get(
    "/providers/:providerId/delegations",
    {
      preHandler: [app.requireTenant],
      schema: {
        tags: ["delegations"],
        summary: "Who runs this provider's diary",
        description:
          "Every member this diary has been handed to, and what each grant covers. Visible to the owner, who decides it, and to the provider whose diary it is, who does not.",
        params: z.object({ providerId: idSchema }),
        response: {
          200: z.object({ items: z.array(delegationResponseSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { providerId } = request.params;
      assertMayRead(request, providerId);

      const rows = await service.listForProvider({
        tenantId: request.tenant!.id,
        providerId,
      });

      return { items: rows.map(toDelegationResponse) };
    },
  );

  app.get(
    "/providers/:providerId/delegations/candidates",
    {
      preHandler: [app.requirePermission(Permissions.DELEGATION_MANAGE)],
      schema: {
        tags: ["delegations"],
        summary: "Members this diary could be handed to",
        description:
          "Active members whose role can hold a delegated diary, excluding the member who already is this provider. `alreadyDelegated` says whether they hold a grant now, so one list drives both adding and re-scoping. This exists rather than filtering the members list client-side because the eligibility rule is a permission question and must not become a role comparison in the browser.",
        params: z.object({ providerId: idSchema }),
        response: {
          200: z.object({ items: z.array(delegationCandidateSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const items = await service.listCandidates({
        tenantId: request.tenant!.id,
        providerId: request.params.providerId,
      });

      return { items };
    },
  );

  app.put(
    "/providers/:providerId/delegations/:membershipId",
    {
      preHandler: [
        app.requireWritableTenant,
        app.requirePermission(Permissions.DELEGATION_MANAGE),
      ],
      schema: {
        tags: ["delegations"],
        summary: "Hand this diary to a member, or change what their grant covers",
        description:
          "Idempotent by construction: one grant exists per (diary, member), so re-sending re-scopes it rather than creating a second. This is a single-resource upsert and not the whole-set PUT that other endpoints use — the delegate list is deliberately not replaceable in one body, because two people editing different rows of it would clobber each other.",
        params: z.object({ providerId: idSchema, membershipId: idSchema }),
        body: setDelegationBodySchema,
        response: {
          200: delegationResponseSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { providerId, membershipId } = request.params;

      const { delegation, created, previousScopes } = await service.grant({
        tenantId: request.tenant!.id,
        providerId,
        membershipId,
        scopes: request.body.scopes,
        grantedByUserId: request.user!.id,
      });

      // Two actions rather than one, so "when did this person first get this
      // diary" stays a single grep (§5.3). Ids only — never the target's name
      // or email: the audit scrubber does not cover a member's, and audit rows
      // are a twelve-month sink (rule 6).
      request.audit({
        action: created ? "delegation.granted" : "delegation.rescoped",
        entityType: "ProviderDelegation",
        entityId: delegation.id,
        ...(created ? {} : { before: { scopes: previousScopes } }),
        after: { providerId, membershipId, scopes: delegation.scopes },
      });

      return toDelegationResponse(delegation);
    },
  );

  app.delete(
    "/providers/:providerId/delegations/:membershipId",
    {
      preHandler: [
        app.requireWritableTenant,
        app.requirePermission(Permissions.DELEGATION_MANAGE),
      ],
      schema: {
        tags: ["delegations"],
        summary: "Take this diary back",
        description:
          "A hard delete, not a flag: nothing points at a delegation, and a soft-deleted grant would put a filter into every read path where forgetting it once is a live privilege leak. The history is in the audit log. Takes effect on the delegate's next request.",
        params: z.object({ providerId: idSchema, membershipId: idSchema }),
        response: {
          204: z.null(),
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { providerId, membershipId } = request.params;

      const removed = await service.revoke({
        tenantId: request.tenant!.id,
        providerId,
        membershipId,
      });

      request.audit({
        action: "delegation.revoked",
        entityType: "ProviderDelegation",
        entityId: removed.id,
        before: { providerId, membershipId, scopes: removed.scopes },
      });

      return reply.status(204).send(null);
    },
  );

  // --- Invite somebody who is not a member yet -------------------------------
  //
  // The two-step alternative — invite from Overview, then assign here — is what
  // this replaces. It also produced no email at all for an assistant, which is
  // how the gap was found (phase-1 §5.1 covers the half that remains).
  app.post(
    "/providers/:providerId/delegations/invitation",
    {
      preHandler: [
        app.requireWritableTenant,
        app.requirePermission(Permissions.DELEGATION_MANAGE),
      ],
      // The same budget as every other invitation route: the same act.
      config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
      schema: {
        tags: ["delegations"],
        summary: "Invite an assistant for this diary",
        description:
          "Emails a single-use link to someone who is not a member yet. Accepting it creates the ASSISTANT membership and assigns them to this diary in one transaction — there is no second step, and no window in which they are a member holding nothing. Somebody who is already a member is refused: assign them from the list instead.",
        params: z.object({ providerId: idSchema }),
        body: inviteDelegateBodySchema,
        response: {
          201: inviteDelegateResponseSchema,
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant!;
      const { providerId } = request.params;

      // Without includeArchived: an archived diary is a 404 here by
      // construction, the same answer as "no such provider" (rule 5).
      const provider = await providers.findByIdOrThrow({ tenantId: tenant.id, providerId });

      const result = await memberships.inviteDelegate({
        tenantId: tenant.id,
        provider,
        email: request.body.email,
        scopes: request.body.scopes,
        invitedByUserId: request.user!.id,
        invitedByName: request.user!.name,
        expiryHours: options.invitationExpiryHours,
      });

      // The same action a generic invitation records, so "who was invited into
      // this tenant" stays one grep. The token is never audited or logged.
      request.audit({
        action: "membership.invited",
        entityType: "Invitation",
        entityId: result.invitationId,
        after: {
          email: result.email,
          role: "ASSISTANT",
          delegatedProviderId: providerId,
          scopes: request.body.scopes,
        },
      });

      return reply.status(201).send({
        id: result.invitationId,
        email: result.email,
        providerId,
        scopes: request.body.scopes,
        expiresAt: result.expiresAt.toISOString(),
        acceptUrl: buildAppUrl({
          baseUrl: options.appBaseUrl,
          path: `/invitations/${result.token}`,
          locale: tenant.defaultLanguage,
        }),
      });
    },
  );
};

/**
 * The delegate's own view. Mounted under `/v1/me`.
 *
 * Separate plugin because the resource is the caller rather than a diary, which
 * is also why it needs no per-provider check: it can only ever return the
 * caller's own grants, in the tenant the request resolved to.
 */
export const myDelegationRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new DelegationService(app.prisma);

  app.get(
    "/delegations",
    {
      preHandler: [app.requirePermission(Permissions.TENANT_READ)],
      schema: {
        tags: ["delegations"],
        summary: "Whose diaries do I run",
        description:
          "The diaries handed to the caller in this tenant, with what each grant covers and enough of the provider to label a picker. An archived diary keeps its grant and is flagged rather than hidden, because its bookings still need managing.",
        response: {
          200: z.object({ items: z.array(myDelegationSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const membershipId = request.actor?.membership?.id;

      // A platform admin resolves a tenant but holds no membership (rule 9), so
      // they run nobody's diary. An empty list is the honest answer.
      if (membershipId === undefined) return { items: [] };

      const items = await service.listMine({
        tenantId: request.tenant!.id,
        membershipId,
      });

      return { items };
    },
  );
};
