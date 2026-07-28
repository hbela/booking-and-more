import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { Permissions, canChangeMemberRole, canRemoveMember } from "@bam/auth";
import { ForbiddenError, NotFoundError, commonErrorResponses, idSchema } from "@bam/contracts";
import { MembershipService } from "./membership.service.js";

const roleSchema = z.enum(["OWNER", "ADMIN", "PROVIDER", "ASSISTANT", "CUSTOMER"]);
/**
 * Roles grantable by invitation. Spelled out rather than derived from
 * INVITABLE_ROLES so Zod infers a literal union instead of `string` — the
 * derived version type-checked but let any string through the handler types.
 * Kept in step with @bam/auth by the test in membership.test.ts.
 */
const invitableRoleSchema = z.enum(["OWNER", "ADMIN", "PROVIDER", "ASSISTANT"]);

const memberResponseSchema = z.object({
  id: idSchema,
  role: roleSchema,
  status: z.enum(["INVITED", "ACTIVE", "SUSPENDED"]),
  providerId: z.string().nullable(),
  joinedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  user: z.object({ id: idSchema, name: z.string(), email: z.email() }),
});

const invitationResponseSchema = z.object({
  id: idSchema,
  email: z.email(),
  role: roleSchema,
  status: z.enum(["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"]),
  expiresAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
  invitedBy: z.object({ id: idSchema, name: z.string(), email: z.email() }),
});

export interface MembershipRoutesOptions {
  invitationExpiryHours: number;
  appBaseUrl: string;
}

export const membershipRoutes: FastifyPluginAsyncZod<MembershipRoutesOptions> = async (
  app,
  options,
) => {
  const service = new MembershipService(app.prisma);

  // --- List members ---------------------------------------------------------
  app.get(
    "",
    {
      preHandler: [app.requirePermission(Permissions.MEMBER_READ)],
      schema: {
        tags: ["members"],
        summary: "List the tenant's members",
        response: {
          200: z.object({ items: z.array(memberResponseSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const members = await service.list(request.tenant!.id);

      return {
        items: members.map((member) => ({
          id: member.id,
          role: member.role,
          status: member.status,
          providerId: member.providerId,
          joinedAt: member.joinedAt?.toISOString() ?? null,
          createdAt: member.createdAt.toISOString(),
          user: member.user,
        })),
      };
    },
  );

  // --- Change a member's role, or link them to a provider -------------------
  app.patch(
    "/:membershipId",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.MEMBER_MANAGE)],
      schema: {
        tags: ["members"],
        summary: "Change a member's role or provider link",
        description:
          "You cannot change your own role, and the last owner cannot be demoted — either would leave a tenant nobody can administer. Linking a provider is what gives a member the `:own` scope over that diary; pass null to unlink.",
        params: z.object({ membershipId: idSchema }),
        body: z
          .object({
            role: invitableRoleSchema.optional(),
            providerId: idSchema.nullable().optional(),
          })
          .refine(
            (body) => body.role !== undefined || body.providerId !== undefined,
            "Provide a role, a providerId, or both.",
          ),
        response: { 200: memberResponseSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenant = request.tenant!;
      const actor = request.actor!;
      const { membershipId } = request.params;
      const { role, providerId } = request.body;

      const before = await service.findById(tenant.id, membershipId);
      let updated = before;

      if (role !== undefined) {
        // Self-demotion and self-promotion are both refused. The permission
        // check in the preHandler is not enough — this rule is about *which*
        // member. It applies to the role only: linking yourself to your own
        // provider record grants a strict subset of what you already hold.
        if (!canChangeMemberRole(actor, tenant.id, membershipId)) {
          throw new ForbiddenError("You cannot change your own role.");
        }

        updated = await service.changeRole(tenant.id, membershipId, role);

        request.audit({
          action: "membership.role_changed",
          entityType: "Membership",
          entityId: membershipId,
          before: { role: before?.role, userId: before?.userId },
          after: { role: updated.role, userId: updated.userId },
        });
      }

      if (providerId !== undefined) {
        updated = await service.linkProvider(tenant.id, membershipId, providerId);

        request.audit({
          action:
            providerId === null ? "membership.provider_unlinked" : "membership.provider_linked",
          entityType: "Membership",
          entityId: membershipId,
          before: { providerId: before?.providerId },
          after: { providerId },
        });
      }

      if (!updated) {
        throw new NotFoundError("Member not found.");
      }

      return {
        id: updated.id,
        role: updated.role,
        status: updated.status,
        providerId: updated.providerId,
        joinedAt: updated.joinedAt?.toISOString() ?? null,
        createdAt: updated.createdAt.toISOString(),
        user: updated.user,
      };
    },
  );

  // --- Remove a member ------------------------------------------------------
  app.delete(
    "/:membershipId",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.MEMBER_MANAGE)],
      schema: {
        tags: ["members"],
        summary: "Remove a member from the tenant",
        params: z.object({ membershipId: idSchema }),
        response: { 204: z.null(), ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant!;

      if (!canRemoveMember(request.actor!, tenant.id)) {
        throw new ForbiddenError("You do not have permission to remove members.");
      }

      const before = await service.findById(tenant.id, request.params.membershipId);
      await service.remove(tenant.id, request.params.membershipId);

      request.audit({
        action: "membership.removed",
        entityType: "Membership",
        entityId: request.params.membershipId,
        before: { role: before?.role, userId: before?.userId },
      });

      return reply.status(204).send(null);
    },
  );

  // --- Invite ---------------------------------------------------------------
  app.post(
    "/invitations",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.MEMBER_MANAGE)],
      config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
      schema: {
        tags: ["members"],
        summary: "Invite someone to the tenant",
        description:
          "Returns the acceptance URL once. Only a SHA-256 hash of the token is stored, so the link cannot be recovered afterwards. Epic 5 delivers this by email instead.",
        body: z.object({ email: z.email(), role: invitableRoleSchema }),
        response: {
          201: z.object({
            id: idSchema,
            email: z.email(),
            role: roleSchema,
            expiresAt: z.iso.datetime({ offset: true }),
            /** Shown once. See the description. */
            acceptUrl: z.url(),
          }),
          ...commonErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant!;

      const result = await service.invite({
        tenantId: tenant.id,
        email: request.body.email,
        role: request.body.role,
        invitedByUserId: request.user!.id,
        expiryHours: options.invitationExpiryHours,
      });

      // The token itself is never audited or logged — only that an invite was
      // issued, to whom, and with what role.
      request.audit({
        action: "membership.invited",
        entityType: "Invitation",
        entityId: result.invitationId,
        after: { email: request.body.email, role: request.body.role },
      });

      return reply.status(201).send({
        id: result.invitationId,
        email: request.body.email,
        role: request.body.role,
        expiresAt: result.expiresAt.toISOString(),
        acceptUrl: `${options.appBaseUrl}/invitations/${result.token}`,
      });
    },
  );

  // --- List pending invitations --------------------------------------------
  app.get(
    "/invitations",
    {
      preHandler: [app.requirePermission(Permissions.MEMBER_READ)],
      schema: {
        tags: ["members"],
        summary: "List pending invitations",
        response: {
          200: z.object({ items: z.array(invitationResponseSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const invitations = await service.listInvitations(request.tenant!.id);

      return {
        items: invitations.map((invitation) => ({
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          status: invitation.status,
          expiresAt: invitation.expiresAt.toISOString(),
          createdAt: invitation.createdAt.toISOString(),
          invitedBy: invitation.invitedBy,
        })),
      };
    },
  );

  // --- Revoke ---------------------------------------------------------------
  app.delete(
    "/invitations/:invitationId",
    {
      preHandler: [app.requireWritableTenant, app.requirePermission(Permissions.MEMBER_MANAGE)],
      schema: {
        tags: ["members"],
        summary: "Revoke a pending invitation",
        params: z.object({ invitationId: idSchema }),
        response: { 204: z.null(), ...commonErrorResponses },
      },
    },
    async (request, reply) => {
      await service.revokeInvitation(request.tenant!.id, request.params.invitationId);

      request.audit({
        action: "membership.invitation_revoked",
        entityType: "Invitation",
        entityId: request.params.invitationId,
      });

      return reply.status(204).send(null);
    },
  );
};

/**
 * Invitation acceptance.
 *
 * Registered outside the tenant-scoped prefix on purpose: the person accepting
 * is by definition not yet a member, so no tenant context can be resolved for
 * them. Authentication is still required — the invited address must match the
 * signed-in one.
 */
export const invitationAcceptRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = new MembershipService(app.prisma);

  app.post(
    "/accept",
    {
      preHandler: [app.requireAuth],
      config: {
        // The token is unguessable, but rate limiting closes off bulk probing.
        rateLimit: { max: 10, timeWindow: "1 hour" },
      },
      schema: {
        tags: ["members"],
        summary: "Accept an invitation",
        description:
          "The signed-in user's email must match the invited address. Invalid, revoked and already-used tokens all return the same error.",
        body: z.object({ token: z.string().min(20).max(200) }),
        response: {
          200: z.object({ tenantId: idSchema, role: roleSchema }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const user = request.user!;
      const result = await service.acceptInvitation(request.body.token, user.id, user.email);

      request.audit({
        action: "membership.invitation_accepted",
        entityType: "Membership",
        entityId: result.membership.id,
        tenantId: result.tenantId,
        after: { role: result.membership.role, userId: user.id },
      });

      return { tenantId: result.tenantId, role: result.membership.role };
    },
  );
};
