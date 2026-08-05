import type { Prisma, PrismaClient, Provider } from "@bam/db";
import { ErrorCodes, NotFoundError } from "@bam/contracts";
import { decodeCursor, takeFor } from "../../lib/pagination.js";

/**
 * Data access for providers.
 *
 * ## The one rule this file exists to enforce
 *
 * `tenantId` is a required parameter on every method, and it is part of every
 * `where` clause — never optional, never inferred from ambient state
 * (CLAUDE.md rule 5, tech-impl §34.2). Even the by-id lookups filter on it, so a
 * provider id guessed or leaked from another tenant resolves to nothing.
 *
 * Writes use Prisma's extended unique filter (`{ id, tenantId }`): the id makes
 * the row addressable, the tenant makes it *ours*. A caller from another tenant
 * gets P2025, which surfaces as the same 404 as an id that never existed.
 */
export class ProviderRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * One page of providers, ordered by display name.
   *
   * Sorting by a non-unique column is why the cursor carries the id as well —
   * see lib/pagination.ts.
   */
  async list(args: {
    tenantId: string;
    limit: number;
    cursor?: string | undefined;
    includeArchived?: boolean;
    active?: boolean | undefined;
    /** Public listings need only what a customer may book. */
    onlineBookingOnly?: boolean;
  }): Promise<Provider[]> {
    const cursor = args.cursor === undefined ? undefined : decodeCursor(args.cursor);

    return this.prisma.provider.findMany({
      where: {
        tenantId: args.tenantId,
        ...(args.includeArchived === true ? {} : { archivedAt: null }),
        ...(args.active === undefined ? {} : { active: args.active }),
        ...(args.onlineBookingOnly === true ? { onlineBookingEnabled: true } : {}),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { displayName: { gt: cursor.sortValue } },
                { displayName: cursor.sortValue, id: { gt: cursor.id } },
              ],
            }),
      },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      take: takeFor(args.limit),
    });
  }

  async findById(args: {
    tenantId: string;
    providerId: string;
    includeArchived?: boolean;
  }): Promise<Provider | null> {
    return this.prisma.provider.findFirst({
      where: {
        id: args.providerId,
        tenantId: args.tenantId,
        ...(args.includeArchived === true ? {} : { archivedAt: null }),
      },
    });
  }

  /** Throws the caller-facing 404 rather than returning null. */
  async findByIdOrThrow(args: {
    tenantId: string;
    providerId: string;
    includeArchived?: boolean;
  }): Promise<Provider> {
    const provider = await this.findById(args);
    if (!provider) throw providerNotFound();
    return provider;
  }

  async create(args: {
    tenantId: string;
    data: Omit<Prisma.ProviderUncheckedCreateInput, "tenantId">;
  }): Promise<Provider> {
    return this.prisma.provider.create({
      data: { ...args.data, tenantId: args.tenantId },
    });
  }

  async update(args: {
    tenantId: string;
    providerId: string;
    data: Prisma.ProviderUncheckedUpdateInput;
  }): Promise<Provider> {
    try {
      return await this.prisma.provider.update({
        where: { id: args.providerId, tenantId: args.tenantId },
        data: args.data,
      });
    } catch (error) {
      if (isRecordNotFound(error)) throw providerNotFound();
      throw error;
    }
  }

  /**
   * Archive rather than delete.
   *
   * Deactivating as well as stamping `archivedAt` is deliberate: every
   * availability and booking query already filters on `active`, so an archived
   * provider drops out of them without each of those queries having to learn
   * about archiving too.
   */
  async archive(args: { tenantId: string; providerId: string }): Promise<Provider> {
    return this.update({
      tenantId: args.tenantId,
      providerId: args.providerId,
      data: { archivedAt: new Date(), active: false },
    });
  }

  /**
   * The inverse of {@link archive} — but only half of it.
   *
   * `active` is deliberately left false. Archiving answers "is this gone?" and
   * deactivating answers "is this off right now?", and those are two different
   * questions (CLAUDE.md rule 11). Restoring both would put the provider back in
   * front of customers in one click, because every public query filters on
   * `active && archivedAt === null` — so reactivating stays a separate,
   * deliberate press.
   */
  async restore(args: { tenantId: string; providerId: string }): Promise<Provider> {
    return this.update({
      tenantId: args.tenantId,
      providerId: args.providerId,
      data: { archivedAt: null },
    });
  }

  /** Services this provider offers, with the underlying service for display. */
  async listServices(args: {
    tenantId: string;
    providerId: string;
    activeOnly?: boolean;
  }): Promise<Prisma.ProviderServiceGetPayload<{ include: { service: true } }>[]> {
    return this.prisma.providerService.findMany({
      where: {
        tenantId: args.tenantId,
        providerId: args.providerId,
        ...(args.activeOnly === true
          ? { active: true, service: { active: true, archivedAt: null } }
          : {}),
      },
      include: { service: true },
      orderBy: { service: { name: "asc" } },
    });
  }

  async listLocations(args: {
    tenantId: string;
    providerId: string;
    activeOnly?: boolean;
  }): Promise<Prisma.ProviderLocationGetPayload<{ include: { location: true } }>[]> {
    return this.prisma.providerLocation.findMany({
      where: {
        tenantId: args.tenantId,
        providerId: args.providerId,
        ...(args.activeOnly === true
          ? { active: true, location: { active: true, archivedAt: null } }
          : {}),
      },
      include: { location: true },
      orderBy: { location: { name: "asc" } },
    });
  }
}

export function providerNotFound(): NotFoundError {
  // Identical whether the provider belongs to another tenant or does not exist.
  // Anything else turns the API into an id-enumeration oracle (tech-impl §34.2).
  return new NotFoundError("Provider not found.", ErrorCodes.PROVIDER_NOT_FOUND);
}

/** Prisma's "record to update/delete does not exist". */
export function isRecordNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2025"
  );
}
