import type { PrismaClient, Provider } from "@bam/db";
import { ErrorCodes, NotFoundError } from "@bam/contracts";
import { definedOnly } from "../../lib/patch.js";
import { ProviderRepository } from "./provider.repository.js";
import type {
  CreateProviderBody,
  ProviderServiceInput,
  UpdateProviderBody,
} from "./provider.schemas.js";

/** Tenant-level fallbacks a new provider inherits. Passed in rather than
 *  re-queried: the request already resolved the tenant. */
export interface TenantDefaults {
  timezone: string;
  language: string;
}

/**
 * Provider lifecycle and assignments.
 *
 * Business rules live here; the route handler validates, delegates and
 * serialises (CLAUDE.md rule 8).
 */
export class ProviderService {
  private readonly providers: ProviderRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.providers = new ProviderRepository(prisma);
  }

  get repository(): ProviderRepository {
    return this.providers;
  }

  /**
   * Create a provider.
   *
   * The timezone and language fallbacks matter more than they look: a provider
   * created without a zone would otherwise carry NULL into the availability
   * engine, and "no zone" during a DST transition is not a question with a
   * sensible default answer (tech-impl §13.4).
   */
  async create(args: {
    tenantId: string;
    input: CreateProviderBody;
    defaults: TenantDefaults;
  }): Promise<Provider> {
    const { input, defaults } = args;

    return this.providers.create({
      tenantId: args.tenantId,
      data: {
        displayName: input.displayName,
        timezone: input.timezone ?? defaults.timezone,
        languages: input.languages ?? [defaults.language],
        ...definedOnly({
          description: input.description,
          email: input.email,
          phone: input.phone,
          active: input.active,
          onlineBookingEnabled: input.onlineBookingEnabled,
          minimumNoticeMinutes: input.minimumNoticeMinutes,
          maximumAdvanceDays: input.maximumAdvanceDays,
        }),
      },
    });
  }

  async update(args: {
    tenantId: string;
    providerId: string;
    input: UpdateProviderBody;
  }): Promise<Provider> {
    return this.providers.update({
      tenantId: args.tenantId,
      providerId: args.providerId,
      // A PATCH body distinguishes "not mentioned" from "explicitly null", and
      // under exactOptionalPropertyTypes an explicit `undefined` is not the same
      // as an omitted key to Prisma.
      data: definedOnly(args.input),
    });
  }

  /** Archive. Never a hard delete — bookings will point here from Epic 4 on. */
  async archive(args: { tenantId: string; providerId: string }): Promise<Provider> {
    return this.providers.archive(args);
  }

  // -------------------------------------------------------------------------
  // Assignments
  // -------------------------------------------------------------------------

  /**
   * Replace the provider's whole service list.
   *
   * Whole-set replacement is what the dashboard's checkbox list actually
   * expresses, and it is idempotent: a double submit converges instead of
   * accumulating duplicates.
   *
   * Every id is verified inside the tenant *before* anything is written. A
   * service id from another tenant is not a permission error — it is a 404,
   * because to this caller that service does not exist.
   */
  async setServices(args: {
    tenantId: string;
    providerId: string;
    services: ProviderServiceInput[];
  }): Promise<void> {
    const { tenantId, providerId, services } = args;

    await this.providers.findByIdOrThrow({ tenantId, providerId });
    await this.assertServicesExist(
      tenantId,
      services.map((entry) => entry.serviceId),
    );

    const keptIds = services.map((entry) => entry.serviceId);

    await this.prisma.$transaction(async (tx) => {
      // Rows dropped from the set go away entirely: an assignment carries no
      // history worth keeping, unlike the service itself.
      await tx.providerService.deleteMany({
        where: { tenantId, providerId, serviceId: { notIn: keptIds } },
      });

      for (const entry of services) {
        const overrides = {
          customDurationMinutes: entry.customDurationMinutes ?? null,
          customPriceMinor: entry.customPriceMinor ?? null,
          active: entry.active,
        };

        await tx.providerService.upsert({
          where: { providerId_serviceId: { providerId, serviceId: entry.serviceId } },
          update: overrides,
          create: { tenantId, providerId, serviceId: entry.serviceId, ...overrides },
        });
      }
    });
  }

  async setLocations(args: {
    tenantId: string;
    providerId: string;
    locations: { locationId: string; active: boolean }[];
  }): Promise<void> {
    const { tenantId, providerId, locations } = args;

    await this.providers.findByIdOrThrow({ tenantId, providerId });
    await this.assertLocationsExist(
      tenantId,
      locations.map((entry) => entry.locationId),
    );

    const keptIds = locations.map((entry) => entry.locationId);

    await this.prisma.$transaction(async (tx) => {
      await tx.providerLocation.deleteMany({
        where: { tenantId, providerId, locationId: { notIn: keptIds } },
      });

      for (const entry of locations) {
        await tx.providerLocation.upsert({
          where: { providerId_locationId: { providerId, locationId: entry.locationId } },
          update: { active: entry.active },
          create: { tenantId, providerId, locationId: entry.locationId, active: entry.active },
        });
      }
    });
  }

  private async assertServicesExist(tenantId: string, serviceIds: string[]): Promise<void> {
    if (serviceIds.length === 0) return;

    const found = await this.prisma.service.findMany({
      where: { tenantId, id: { in: serviceIds }, archivedAt: null },
      select: { id: true },
    });

    const missing = serviceIds.filter((id) => !found.some((row) => row.id === id));
    if (missing.length > 0) {
      throw new NotFoundError("Service not found.", ErrorCodes.SERVICE_NOT_FOUND, {
        serviceIds: missing,
      });
    }
  }

  private async assertLocationsExist(tenantId: string, locationIds: string[]): Promise<void> {
    if (locationIds.length === 0) return;

    const found = await this.prisma.location.findMany({
      where: { tenantId, id: { in: locationIds }, archivedAt: null },
      select: { id: true },
    });

    const missing = locationIds.filter((id) => !found.some((row) => row.id === id));
    if (missing.length > 0) {
      throw new NotFoundError("Location not found.", ErrorCodes.LOCATION_NOT_FOUND, {
        locationIds: missing,
      });
    }
  }
}
