import type { PrismaClient, Provider, Service, ServiceTranslation, Tenant } from "@bam/db";
import { tenantAcceptsWrites } from "@bam/auth";
import { ErrorCodes, NotFoundError } from "@bam/contracts";
import { decodeCursor, takeFor } from "../../lib/pagination.js";
import { providerNotFound } from "../providers/provider.repository.js";
import { serviceNotFound } from "../services/service.repository.js";

/**
 * The public catalogue. tech-impl §16.
 *
 * ## What this class is for
 *
 * Epic 2's exit criterion is "inactive services and providers cannot be
 * publicly booked". That is one sentence and a dozen places to get it wrong, so
 * every public read goes through here and every query carries the same
 * predicate:
 *
 *   - the tenant accepts bookings at all,
 *   - the row is `active` and not archived,
 *   - for providers, `onlineBookingEnabled` as well,
 *   - and the two are joined by an assignment that is itself active.
 *
 * The last one is the part that is easy to forget: an active service nobody is
 * assigned to is not bookable, and offering it produces a customer who picks a
 * service and then finds no one to do it.
 *
 * These methods take a resolved tenant rather than a slug wherever they can, so
 * a caller cannot accidentally skip {@link resolveTenant} and its status check.
 */
export class PublicCatalogueService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Find a tenant by its public slug.
   *
   * A suspended, trialling-then-closed or nonexistent slug all return the same
   * 404. A business that has stopped paying should not have a booking page that
   * takes appointments it will never honour, and it should not be distinguishable
   * from one that never existed either.
   */
  async resolveTenant(slug: string): Promise<Tenant> {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug } });

    if (!tenant || !tenantAcceptsWrites(tenant.status)) {
      throw new NotFoundError(
        "No booking page found at that address.",
        ErrorCodes.TENANT_NOT_FOUND,
      );
    }

    return tenant;
  }

  /** Locations a customer could be sent to. */
  async listLocations(tenantId: string) {
    return this.prisma.location.findMany({
      where: { tenantId, active: true, archivedAt: null },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
  }

  /** Every locale the tenant can serve: its own, plus translated services. */
  async availableLocales(tenant: Tenant): Promise<string[]> {
    const rows = await this.prisma.serviceTranslation.findMany({
      where: { service: { tenantId: tenant.id, active: true, archivedAt: null } },
      select: { locale: true },
      distinct: ["locale"],
    });

    return [...new Set([tenant.defaultLanguage, ...rows.map((row) => row.locale)])].sort();
  }

  async listServices(args: {
    tenantId: string;
    limit: number;
    cursor?: string | undefined;
    providerId?: string | undefined;
  }): Promise<(Service & { translations: ServiceTranslation[] })[]> {
    const cursor = args.cursor === undefined ? undefined : decodeCursor(args.cursor);

    return this.prisma.service.findMany({
      where: {
        tenantId: args.tenantId,
        active: true,
        archivedAt: null,
        providers: {
          some: {
            active: true,
            ...(args.providerId === undefined ? {} : { providerId: args.providerId }),
            provider: bookableProvider,
          },
        },
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { name: { gt: cursor.sortValue } },
                { name: cursor.sortValue, id: { gt: cursor.id } },
              ],
            }),
      },
      include: { translations: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: takeFor(args.limit),
    });
  }

  async findService(args: {
    tenantId: string;
    serviceId: string;
  }): Promise<Service & { translations: ServiceTranslation[] }> {
    const service = await this.prisma.service.findFirst({
      where: {
        id: args.serviceId,
        tenantId: args.tenantId,
        active: true,
        archivedAt: null,
        providers: { some: { active: true, provider: bookableProvider } },
      },
      include: { translations: true },
    });

    // An inactive service is 404 here even though it exists and a staff user can
    // read it. From the public side it is not part of the catalogue, and saying
    // "this exists but you may not have it" would leak the tenant's roster.
    if (!service) throw serviceNotFound();
    return service;
  }

  async listProviders(args: {
    tenantId: string;
    limit: number;
    cursor?: string | undefined;
    serviceId?: string | undefined;
  }): Promise<Provider[]> {
    const cursor = args.cursor === undefined ? undefined : decodeCursor(args.cursor);

    return this.prisma.provider.findMany({
      where: {
        tenantId: args.tenantId,
        ...bookableProvider,
        services: {
          some: {
            active: true,
            ...(args.serviceId === undefined ? {} : { serviceId: args.serviceId }),
            service: { active: true, archivedAt: null },
          },
        },
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

  async findProvider(args: { tenantId: string; providerId: string }): Promise<Provider> {
    const provider = await this.prisma.provider.findFirst({
      where: {
        id: args.providerId,
        tenantId: args.tenantId,
        ...bookableProvider,
        services: { some: { active: true, service: { active: true, archivedAt: null } } },
      },
    });

    if (!provider) throw providerNotFound();
    return provider;
  }
}

/** The three conditions that make a provider bookable from the outside. */
const bookableProvider = {
  active: true,
  archivedAt: null,
  onlineBookingEnabled: true,
} as const;

/**
 * Resolve a service's name and description for a locale, falling back to the
 * service's own fields.
 *
 * The fallback is per-field rather than per-translation: a tenant that
 * translated the name but left the description blank should get the translated
 * name, not lose both (tech-impl §38).
 */
export function localiseService(
  service: Service & { translations: ServiceTranslation[] },
  locale: string,
): { name: string; description: string | null } {
  const translation = service.translations.find((entry) => entry.locale === locale);

  return {
    name: translation?.name ?? service.name,
    description: translation?.description ?? service.description,
  };
}
