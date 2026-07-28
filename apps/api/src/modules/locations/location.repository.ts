import type { Location, Prisma, PrismaClient } from "@bam/db";
import { ErrorCodes, NotFoundError } from "@bam/contracts";
import { decodeCursor, takeFor } from "../../lib/pagination.js";
import { isRecordNotFound } from "../providers/provider.repository.js";

/**
 * Data access for locations.
 *
 * `tenantId` is required on every call and present in every `where` clause
 * (CLAUDE.md rule 5).
 */
export class LocationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(args: {
    tenantId: string;
    limit: number;
    cursor?: string | undefined;
    includeArchived?: boolean;
    active?: boolean | undefined;
  }): Promise<Location[]> {
    const cursor = args.cursor === undefined ? undefined : decodeCursor(args.cursor);

    return this.prisma.location.findMany({
      where: {
        tenantId: args.tenantId,
        ...(args.includeArchived === true ? {} : { archivedAt: null }),
        ...(args.active === undefined ? {} : { active: args.active }),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { name: { gt: cursor.sortValue } },
                { name: cursor.sortValue, id: { gt: cursor.id } },
              ],
            }),
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: takeFor(args.limit),
    });
  }

  async findById(args: {
    tenantId: string;
    locationId: string;
    includeArchived?: boolean;
  }): Promise<Location | null> {
    return this.prisma.location.findFirst({
      where: {
        id: args.locationId,
        tenantId: args.tenantId,
        ...(args.includeArchived === true ? {} : { archivedAt: null }),
      },
    });
  }

  async findByIdOrThrow(args: {
    tenantId: string;
    locationId: string;
    includeArchived?: boolean;
  }): Promise<Location> {
    const location = await this.findById(args);
    if (!location) throw locationNotFound();
    return location;
  }

  async create(args: {
    tenantId: string;
    data: Omit<Prisma.LocationUncheckedCreateInput, "tenantId">;
  }): Promise<Location> {
    return this.prisma.location.create({ data: { ...args.data, tenantId: args.tenantId } });
  }

  async update(args: {
    tenantId: string;
    locationId: string;
    data: Prisma.LocationUncheckedUpdateInput;
  }): Promise<Location> {
    try {
      return await this.prisma.location.update({
        where: { id: args.locationId, tenantId: args.tenantId },
        data: args.data,
      });
    } catch (error) {
      if (isRecordNotFound(error)) throw locationNotFound();
      throw error;
    }
  }

  async archive(args: { tenantId: string; locationId: string }): Promise<Location> {
    return this.update({
      tenantId: args.tenantId,
      locationId: args.locationId,
      data: { archivedAt: new Date(), active: false },
    });
  }
}

export function locationNotFound(): NotFoundError {
  return new NotFoundError("Location not found.", ErrorCodes.LOCATION_NOT_FOUND);
}
