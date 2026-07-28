import type { PrismaClient, Tenant } from "@bam/db";
import { Roles } from "@bam/auth";
import { ConflictError, ErrorCodes, ValidationError } from "@bam/contracts";
import { RESERVED_SLUGS, type CreateTenantBody, type UpdateTenantBody } from "./tenant.schemas.js";

/**
 * Tenant lifecycle. Business rules live here, not in the route handler
 * (CLAUDE.md rule 8).
 */
export class TenantService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Create a tenant and make the creator its OWNER, in one transaction.
   *
   * The transaction is the point: a tenant with no owner is unreachable — no
   * one can invite anyone, change settings, or delete it — so a partial failure
   * here would leave an orphan row that only a DBA could clean up.
   */
  async create(input: CreateTenantBody, creatorUserId: string): Promise<Tenant> {
    if (RESERVED_SLUGS.includes(input.slug)) {
      throw new ValidationError(`The slug "${input.slug}" is reserved. Please choose another.`, {
        field: "slug",
      });
    }

    // Checked up front for a clear error message; the unique index below is
    // what actually guarantees it under concurrency.
    const existing = await this.prisma.tenant.findUnique({
      where: { slug: input.slug },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictError(
        ErrorCodes.VALIDATION_FAILED,
        `The slug "${input.slug}" is already taken.`,
        { field: "slug" },
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            name: input.name,
            slug: input.slug,
            defaultTimezone: input.defaultTimezone,
            defaultLanguage: input.defaultLanguage,
            ...(input.contactEmail === undefined ? {} : { contactEmail: input.contactEmail }),
            ...(input.contactPhone === undefined ? {} : { contactPhone: input.contactPhone }),
            status: "TRIAL",
          },
        });

        await tx.membership.create({
          data: {
            tenantId: tenant.id,
            userId: creatorUserId,
            role: Roles.OWNER,
            status: "ACTIVE",
            joinedAt: new Date(),
          },
        });

        return tenant;
      });
    } catch (error) {
      // Lost the race between the check above and the insert.
      if (isUniqueViolation(error, "slug")) {
        throw new ConflictError(
          ErrorCodes.VALIDATION_FAILED,
          `The slug "${input.slug}" is already taken.`,
          { field: "slug" },
        );
      }
      throw error;
    }
  }

  /** Every tenant the user belongs to. Powers the tenant switcher. */
  async listForUser(userId: string): Promise<(Tenant & { role: string })[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId, status: "ACTIVE" },
      include: { tenant: true },
      orderBy: { createdAt: "asc" },
    });

    return (
      memberships
        // A closed tenant is not worth offering; its data is read-only history.
        .filter((membership) => membership.tenant.status !== "CLOSED")
        .map((membership) => ({ ...membership.tenant, role: membership.role }))
    );
  }

  /**
   * Tenant ID is a required parameter, never inferred (CLAUDE.md rule 5).
   * Authorization has already happened in the guard; this is the data access.
   */
  async findById(tenantId: string): Promise<Tenant | null> {
    return this.prisma.tenant.findUnique({ where: { id: tenantId } });
  }

  async update(tenantId: string, input: UpdateTenantBody): Promise<Tenant> {
    // Drop absent keys. A PATCH body distinguishes "not mentioned" (leave alone)
    // from "explicitly null" (clear it), and under exactOptionalPropertyTypes
    // an explicit `undefined` is not the same as an omitted key to Prisma.
    const data = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );

    return this.prisma.tenant.update({
      where: { id: tenantId },
      // Zod has already stripped unknown keys, and `slug` and `status` are not
      // in the update schema at all, so neither can be smuggled through here.
      data,
    });
  }

  /**
   * Set the session's active tenant. A UI convenience — this value is never
   * trusted for authorization; membership is re-checked on every request.
   */
  async setActiveTenant(userId: string, tenantId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, expiresAt: { gt: new Date() } },
      data: { activeTenantId: tenantId },
    });
  }
}

/** Prisma's P2002 unique-constraint violation, optionally on a named field. */
function isUniqueViolation(error: unknown, field?: string): boolean {
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== "P2002") return false;
  if (field === undefined) return true;

  // Prisma reports `target` as either a string or an array of column names,
  // depending on the constraint. Anything else means we cannot tell, so treat
  // it as "not this field" rather than stringifying an object into nonsense.
  const target: unknown = candidate.meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  return typeof target === "string" && target.includes(field);
}
