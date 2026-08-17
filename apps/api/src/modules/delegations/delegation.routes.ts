import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { Permissions, canDelegateProviderDiary } from "@bam/auth";
import { ForbiddenError, commonErrorResponses, idSchema } from "@bam/contracts";
import { DelegationService, toDelegationResponse } from "./delegation.service.js";
import {
  delegationCandidateSchema,
  delegationResponseSchema,
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
 * ## Where the authorization lives
 *
 * The route guard establishes tenant membership only. Whose diary it is depends
 * on the id in the URL, so the handler asks `canDelegateProviderDiary` — the
 * same split availability.routes.ts uses, and for the same reason.
 *
 * That rule is `canForProvider` **without** a delegated branch (§2.3). A
 * delegate therefore cannot hand the diary on, and delegation is one level deep
 * by construction rather than by convention.
 */
export const providerDelegationRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new DelegationService(app.prisma);

  /** 403 unless the actor may hand this particular diary to somebody. */
  function assertMayDelegate(request: FastifyRequest, providerId: string): void {
    const tenant = request.tenant!;
    const actor = request.actor as Parameters<typeof canDelegateProviderDiary>[0];

    if (!canDelegateProviderDiary(actor, tenant.id, providerId)) {
      // Deliberately not "that is not your diary", matching the availability
      // module: the caller learns only that they may not, never whose it is.
      throw new ForbiddenError("You do not have permission to delegate this provider's diary.");
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
          "Every member this diary has been handed to, and what each grant covers. Visible to whoever may delegate it — the provider themselves, an owner or an admin.",
        params: z.object({ providerId: idSchema }),
        response: {
          200: z.object({ items: z.array(delegationResponseSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const { providerId } = request.params;
      assertMayDelegate(request, providerId);

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
      preHandler: [app.requireTenant],
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
      const { providerId } = request.params;
      assertMayDelegate(request, providerId);

      const items = await service.listCandidates({
        tenantId: request.tenant!.id,
        providerId,
      });

      return { items };
    },
  );

  app.put(
    "/providers/:providerId/delegations/:membershipId",
    {
      preHandler: [app.requireWritableTenant, app.requireTenant],
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
      assertMayDelegate(request, providerId);

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
      preHandler: [app.requireWritableTenant, app.requireTenant],
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
      assertMayDelegate(request, providerId);

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
