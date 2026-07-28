import type { Prisma, PrismaClient } from "@bam/db";
import { ErrorCodes, NotFoundError } from "@bam/contracts";
import { decodeCursor, takeFor } from "../../lib/pagination.js";
import { isRecordNotFound } from "../providers/provider.repository.js";

/** A service is never returned without its translations — every read path
 *  needs them, and a second round-trip per row is how N+1 starts. */
const withTranslations = {
  translations: { orderBy: { locale: "asc" } },
} as const satisfies Prisma.ServiceInclude;

export type ServiceWithTranslations = Prisma.ServiceGetPayload<{
  include: typeof withTranslations;
}>;

/**
 * Data access for services.
 *
 * `tenantId` is required on every call and present in every `where` clause
 * (CLAUDE.md rule 5). See provider.repository.ts for the reasoning; it applies
 * unchanged here.
 */
export class ServiceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(args: {
    tenantId: string;
    limit: number;
    cursor?: string | undefined;
    includeArchived?: boolean;
    active?: boolean | undefined;
    /** Restrict to services this provider actually offers. */
    providerId?: string | undefined;
    /** Public listings: the assignment must be live at both ends. */
    bookableOnly?: boolean;
  }): Promise<ServiceWithTranslations[]> {
    const cursor = args.cursor === undefined ? undefined : decodeCursor(args.cursor);

    return this.prisma.service.findMany({
      where: {
        tenantId: args.tenantId,
        ...(args.includeArchived === true ? {} : { archivedAt: null }),
        ...(args.active === undefined ? {} : { active: args.active }),
        ...(args.providerId === undefined
          ? {}
          : {
              providers: {
                some: {
                  providerId: args.providerId,
                  ...(args.bookableOnly === true
                    ? {
                        active: true,
                        provider: { active: true, archivedAt: null, onlineBookingEnabled: true },
                      }
                    : {}),
                },
              },
            }),
        // A service nobody offers cannot be booked, so the public catalogue
        // must not advertise it.
        ...(args.bookableOnly === true && args.providerId === undefined
          ? {
              providers: {
                some: {
                  active: true,
                  provider: { active: true, archivedAt: null, onlineBookingEnabled: true },
                },
              },
            }
          : {}),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { name: { gt: cursor.sortValue } },
                { name: cursor.sortValue, id: { gt: cursor.id } },
              ],
            }),
      },
      include: withTranslations,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: takeFor(args.limit),
    });
  }

  async findById(args: {
    tenantId: string;
    serviceId: string;
    includeArchived?: boolean;
  }): Promise<ServiceWithTranslations | null> {
    return this.prisma.service.findFirst({
      where: {
        id: args.serviceId,
        tenantId: args.tenantId,
        ...(args.includeArchived === true ? {} : { archivedAt: null }),
      },
      include: withTranslations,
    });
  }

  async findByIdOrThrow(args: {
    tenantId: string;
    serviceId: string;
    includeArchived?: boolean;
  }): Promise<ServiceWithTranslations> {
    const service = await this.findById(args);
    if (!service) throw serviceNotFound();
    return service;
  }

  /** Slug uniqueness is per tenant, so this lookup is too. */
  async findBySlug(args: {
    tenantId: string;
    slug: string;
    includeArchived?: boolean;
  }): Promise<ServiceWithTranslations | null> {
    return this.prisma.service.findFirst({
      where: {
        tenantId: args.tenantId,
        slug: args.slug,
        ...(args.includeArchived === true ? {} : { archivedAt: null }),
      },
      include: withTranslations,
    });
  }

  async create(args: {
    tenantId: string;
    data: Omit<Prisma.ServiceUncheckedCreateInput, "tenantId">;
  }): Promise<ServiceWithTranslations> {
    return this.prisma.service.create({
      data: { ...args.data, tenantId: args.tenantId },
      include: withTranslations,
    });
  }

  async update(args: {
    tenantId: string;
    serviceId: string;
    data: Prisma.ServiceUncheckedUpdateInput;
  }): Promise<ServiceWithTranslations> {
    try {
      return await this.prisma.service.update({
        where: { id: args.serviceId, tenantId: args.tenantId },
        data: args.data,
        include: withTranslations,
      });
    } catch (error) {
      if (isRecordNotFound(error)) throw serviceNotFound();
      throw error;
    }
  }

  async archive(args: { tenantId: string; serviceId: string }): Promise<ServiceWithTranslations> {
    return this.update({
      tenantId: args.tenantId,
      serviceId: args.serviceId,
      data: { archivedAt: new Date(), active: false },
    });
  }

  /** Providers offering this service, for the service detail screen. */
  async listProviders(args: {
    tenantId: string;
    serviceId: string;
  }): Promise<Prisma.ProviderServiceGetPayload<{ include: { provider: true } }>[]> {
    return this.prisma.providerService.findMany({
      where: { tenantId: args.tenantId, serviceId: args.serviceId },
      include: { provider: true },
      orderBy: { provider: { displayName: "asc" } },
    });
  }
}

export function serviceNotFound(): NotFoundError {
  return new NotFoundError("Service not found.", ErrorCodes.SERVICE_NOT_FOUND);
}
