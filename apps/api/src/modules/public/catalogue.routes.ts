import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { commonErrorResponses, idSchema, paginatedSchema } from "@bam/contracts";
import { pageOf } from "../../lib/pagination.js";
import { AvailabilityService } from "../availability/availability.service.js";
import { slotResponseSchema, slotSearchBodySchema } from "../availability/availability.schemas.js";
import { PublicCatalogueService, localiseService } from "./catalogue.service.js";
import {
  publicProviderSchema,
  publicProvidersQuerySchema,
  publicServiceSchema,
  publicServicesQuerySchema,
  publicTenantSchema,
  tenantSlugParamsSchema,
} from "./catalogue.schemas.js";

/**
 * The public booking catalogue. tech-impl §16.
 *
 * ## No authentication, and therefore no tenant context
 *
 * These are the only routes in the API that resolve a tenant from a
 * client-supplied value without checking a membership — because the whole point
 * is that a stranger can read them. That makes the *shape* of what they return
 * the security boundary instead: see catalogue.schemas.ts for what is
 * deliberately absent, and catalogue.service.ts for the filters that decide what
 * exists at all.
 *
 * Rate limits are tighter than the global default. An unauthenticated endpoint
 * that runs a join across three tables is exactly what a scraper reaches for
 * first, and until Epic 5 brings Redis these limits are per-instance.
 */
export const publicCatalogueRoutes: FastifyPluginAsyncZod = async (app) => {
  const catalogue = new PublicCatalogueService(app.prisma);
  // Shared with the staff search: one engine, one set of filters, and a
  // `publicOnly` flag rather than a second implementation that can drift.
  const availability = new AvailabilityService(app.prisma);

  const publicRateLimit = { rateLimit: { max: 120, timeWindow: "1 minute" } };

  // --- Tenant ---------------------------------------------------------------
  app.get(
    "/tenants/:tenantSlug",
    {
      config: publicRateLimit,
      schema: {
        tags: ["public"],
        summary: "Read a tenant's public booking page",
        description:
          "Branding, policies, languages and locations. Suspended and closed tenants return 404: a business that cannot take a booking should not show a page that invites one.",
        params: tenantSlugParamsSchema,
        response: { 200: publicTenantSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenant = await catalogue.resolveTenant(request.params.tenantSlug);
      const [locations, languages] = await Promise.all([
        catalogue.listLocations(tenant.id),
        catalogue.availableLocales(tenant),
      ]);

      return {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        defaultTimezone: tenant.defaultTimezone,
        defaultLanguage: tenant.defaultLanguage,
        languages,
        logoUrl: tenant.logoUrl,
        primaryColor: tenant.primaryColor,
        contactEmail: tenant.contactEmail,
        contactPhone: tenant.contactPhone,
        bookingPolicy: tenant.bookingPolicy,
        cancellationPolicy: tenant.cancellationPolicy,
        privacyPolicyUrl: tenant.privacyPolicyUrl,
        locations: locations.map((location) => ({
          id: location.id,
          name: location.name,
          type: location.type,
          addressLine1: location.addressLine1,
          addressLine2: location.addressLine2,
          city: location.city,
          postalCode: location.postalCode,
          countryCode: location.countryCode,
          timezone: location.timezone,
          latitude: location.latitude,
          longitude: location.longitude,
        })),
      };
    },
  );

  // --- Services -------------------------------------------------------------
  app.get(
    "/tenants/:tenantSlug/services",
    {
      config: publicRateLimit,
      schema: {
        tags: ["public"],
        summary: "List bookable services",
        description:
          "Only services that are active, not archived, and offered by at least one bookable provider. Names and descriptions are already resolved for the requested locale.",
        params: tenantSlugParamsSchema,
        querystring: publicServicesQuerySchema,
        response: { 200: paginatedSchema(publicServiceSchema), ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenant = await catalogue.resolveTenant(request.params.tenantSlug);
      const { limit, cursor, providerId } = request.query;
      const locale = request.query.locale ?? tenant.defaultLanguage;

      const rows = await catalogue.listServices({
        tenantId: tenant.id,
        limit,
        cursor,
        providerId,
      });

      return pageOf(
        rows,
        limit,
        (row) => row.name,
        (row) => toPublicService(row, locale),
      );
    },
  );

  app.get(
    "/tenants/:tenantSlug/services/:serviceId",
    {
      config: publicRateLimit,
      schema: {
        tags: ["public"],
        summary: "Read one bookable service",
        params: tenantSlugParamsSchema.extend({ serviceId: idSchema }),
        querystring: z.object({ locale: publicServicesQuerySchema.shape.locale }),
        response: { 200: publicServiceSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenant = await catalogue.resolveTenant(request.params.tenantSlug);
      const locale = request.query.locale ?? tenant.defaultLanguage;

      const service = await catalogue.findService({
        tenantId: tenant.id,
        serviceId: request.params.serviceId,
      });

      return toPublicService(service, locale);
    },
  );

  // --- Providers ------------------------------------------------------------
  app.get(
    "/tenants/:tenantSlug/providers",
    {
      config: publicRateLimit,
      schema: {
        tags: ["public"],
        summary: "List bookable providers",
        description:
          "Only providers that are active, not archived, have online booking enabled, and offer at least one active service. Contact details are staff data and are not returned.",
        params: tenantSlugParamsSchema,
        querystring: publicProvidersQuerySchema,
        response: { 200: paginatedSchema(publicProviderSchema), ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenant = await catalogue.resolveTenant(request.params.tenantSlug);
      const { limit, cursor, serviceId } = request.query;

      const rows = await catalogue.listProviders({
        tenantId: tenant.id,
        limit,
        cursor,
        serviceId,
      });

      return pageOf(rows, limit, (row) => row.displayName, toPublicProvider);
    },
  );

  // --- Slot search ----------------------------------------------------------
  app.post(
    "/tenants/:tenantSlug/slots/search",
    {
      config: {
        // Tighter than the read endpoints: this one runs the availability
        // engine over a date range, so it is the most expensive thing an
        // anonymous caller can ask for.
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
      schema: {
        tags: ["public"],
        summary: "Find bookable slots",
        description:
          "Only providers a customer may actually book — active, not archived, online booking enabled, and assigned to this service. Times are absolute instants; the caller renders them in whatever zone it likes.",
        params: tenantSlugParamsSchema,
        body: slotSearchBodySchema,
        response: {
          200: z.object({ items: z.array(slotResponseSchema) }),
          ...commonErrorResponses,
        },
      },
    },
    async (request) => {
      const tenant = await catalogue.resolveTenant(request.params.tenantSlug);

      const slots = await availability.searchSlots({
        tenantId: tenant.id,
        input: request.body,
        now: new Date(),
        // The difference that matters: an inactive service or an unpublished
        // provider is invisible here, exactly as in the catalogue above.
        publicOnly: true,
      });

      return { items: slots };
    },
  );

  app.get(
    "/tenants/:tenantSlug/providers/:providerId",
    {
      config: publicRateLimit,
      schema: {
        tags: ["public"],
        summary: "Read one bookable provider",
        params: tenantSlugParamsSchema.extend({ providerId: idSchema }),
        response: { 200: publicProviderSchema, ...commonErrorResponses },
      },
    },
    async (request) => {
      const tenant = await catalogue.resolveTenant(request.params.tenantSlug);

      const provider = await catalogue.findProvider({
        tenantId: tenant.id,
        providerId: request.params.providerId,
      });

      return toPublicProvider(provider);
    },
  );
};

function toPublicService(
  service: Parameters<typeof localiseService>[0],
  locale: string,
): z.infer<typeof publicServiceSchema> {
  const { name, description } = localiseService(service, locale);

  return {
    id: service.id,
    slug: service.slug,
    name,
    description,
    // The customer-facing duration excludes buffers: the padding is the
    // clinic's business, and showing a 40-minute cleaning as 55 would be a lie.
    durationMinutes: service.durationMinutes,
    priceMinor: service.priceMinor,
    currency: service.currency,
    requiresApproval: service.requiresApproval,
  };
}

function toPublicProvider(provider: {
  id: string;
  displayName: string;
  description: string | null;
  languages: string[];
  timezone: string;
}): z.infer<typeof publicProviderSchema> {
  return {
    id: provider.id,
    displayName: provider.displayName,
    description: provider.description,
    languages: provider.languages,
    timezone: provider.timezone,
  };
}
