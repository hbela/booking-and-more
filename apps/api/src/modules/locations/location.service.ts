import type { Location, PrismaClient } from "@bam/db";
import { ValidationError } from "@bam/contracts";
import { definedOnly } from "../../lib/patch.js";
import { LocationRepository } from "./location.repository.js";
import {
  ADDRESSED_TYPES,
  type CreateLocationBody,
  type UpdateLocationBody,
} from "./location.schemas.js";

export class LocationService {
  private readonly locations: LocationRepository;

  constructor(prisma: PrismaClient) {
    this.locations = new LocationRepository(prisma);
  }

  get repository(): LocationRepository {
    return this.locations;
  }

  /**
   * Create a location.
   *
   * The zone falls back to the tenant's rather than being left NULL: slots are
   * computed in the location's zone (tech-impl §13.4), and "unknown zone" is not
   * something the availability engine should have to reason about.
   */
  async create(args: {
    tenantId: string;
    input: CreateLocationBody;
    defaultTimezone: string;
  }): Promise<Location> {
    const { input } = args;

    return this.locations.create({
      tenantId: args.tenantId,
      data: {
        name: input.name,
        type: input.type,
        timezone: input.timezone ?? args.defaultTimezone,
        ...definedOnly({
          active: input.active,
          addressLine1: input.addressLine1,
          addressLine2: input.addressLine2,
          city: input.city,
          postalCode: input.postalCode,
          countryCode: input.countryCode,
          latitude: input.latitude,
          longitude: input.longitude,
        }),
      },
    });
  }

  /**
   * Update a location.
   *
   * The "a physical location needs an address" rule is re-checked against the
   * merged result, not the patch: switching an ONLINE location to PHYSICAL in a
   * body that carries no address must fail, and clearing the address of a
   * location that is already PHYSICAL must fail too.
   */
  async update(args: {
    tenantId: string;
    locationId: string;
    input: UpdateLocationBody;
  }): Promise<Location> {
    const { tenantId, locationId, input } = args;
    const current = await this.locations.findByIdOrThrow({ tenantId, locationId });

    const type = input.type ?? current.type;
    const addressLine1 =
      input.addressLine1 === undefined ? current.addressLine1 : input.addressLine1;

    if (ADDRESSED_TYPES.includes(type) && !addressLine1) {
      throw new ValidationError("A physical location needs a street address.", {
        field: "addressLine1",
      });
    }

    return this.locations.update({
      tenantId,
      locationId,
      data: definedOnly(input),
    });
  }

  async archive(args: { tenantId: string; locationId: string }): Promise<Location> {
    return this.locations.archive(args);
  }
}
