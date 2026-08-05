import type { PrismaClient } from "@bam/db";
import { ConflictError, ErrorCodes, ValidationError } from "@bam/contracts";
import { definedOnly } from "../../lib/patch.js";
import { ServiceRepository, type ServiceWithTranslations } from "./service.repository.js";
import type {
  CreateServiceBody,
  ServiceTranslationInput,
  UpdateServiceBody,
} from "./service.schemas.js";

/**
 * Service catalogue rules.
 *
 * Named `ServiceCatalogService` because `ServiceService` is not a word anybody
 * should have to read twice; the file name follows the module convention
 * (tech-impl §6) regardless.
 */
export class ServiceCatalogService {
  private readonly services: ServiceRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.services = new ServiceRepository(prisma);
  }

  get repository(): ServiceRepository {
    return this.services;
  }

  async create(args: {
    tenantId: string;
    input: CreateServiceBody;
  }): Promise<ServiceWithTranslations> {
    const { tenantId, input } = args;
    const slug = input.slug ?? slugify(input.name);

    if (slug.length < 2) {
      // A name of nothing but punctuation or non-Latin script leaves nothing to
      // slugify. Ask for a slug rather than inventing one.
      throw new ValidationError("Could not derive a URL slug from that name. Provide one.", {
        field: "slug",
      });
    }

    await this.assertSlugIsFree({ tenantId, slug });

    const created = await this.services.create({
      tenantId,
      data: {
        name: input.name,
        slug,
        durationMinutes: input.durationMinutes,
        ...definedOnly({
          description: input.description,
          bufferBeforeMinutes: input.bufferBeforeMinutes,
          bufferAfterMinutes: input.bufferAfterMinutes,
          priceMinor: input.priceMinor,
          currency: input.currency,
          active: input.active,
          requiresApproval: input.requiresApproval,
          minimumNoticeMinutes: input.minimumNoticeMinutes,
          maximumAdvanceDays: input.maximumAdvanceDays,
        }),
        ...(input.translations === undefined
          ? {}
          : {
              translations: {
                create: input.translations.map((translation) => ({
                  locale: translation.locale,
                  name: translation.name,
                  description: translation.description ?? null,
                })),
              },
            }),
      },
    });

    return created;
  }

  /**
   * Update a service.
   *
   * The price rule is enforced here rather than in the Zod schema because it
   * spans the request *and* the stored row: setting an amount on a service that
   * already has a currency is fine, setting one on a service that does not is
   * not.
   */
  async update(args: {
    tenantId: string;
    serviceId: string;
    input: UpdateServiceBody;
  }): Promise<ServiceWithTranslations> {
    const { tenantId, serviceId, input } = args;
    const current = await this.services.findByIdOrThrow({ tenantId, serviceId });

    if (input.slug !== undefined && input.slug !== current.slug) {
      await this.assertSlugIsFree({ tenantId, slug: input.slug });
    }

    const priceMinor = input.priceMinor === undefined ? current.priceMinor : input.priceMinor;
    const currency = input.currency === undefined ? current.currency : input.currency;

    if (priceMinor !== null && !currency) {
      throw new ValidationError("A currency is required when a price is set.", {
        field: "currency",
      });
    }

    return this.services.update({
      tenantId,
      serviceId,
      data: definedOnly(input),
    });
  }

  async archive(args: { tenantId: string; serviceId: string }): Promise<ServiceWithTranslations> {
    return this.services.archive(args);
  }

  /**
   * Undo an archive. Idempotent — restoring a live service returns it unchanged.
   */
  async restore(args: { tenantId: string; serviceId: string }): Promise<ServiceWithTranslations> {
    // Without `includeArchived` this 404s on exactly the rows it serves.
    const service = await this.services.findByIdOrThrow({ ...args, includeArchived: true });
    if (service.archivedAt === null) return service;

    return this.services.restore(args);
  }

  /**
   * Replace a service's translations. tech-impl §38.
   *
   * Whole-set replacement, like the provider assignments: the translation editor
   * shows every locale at once, so "here is the complete set" is what the user
   * actually expressed. A locale dropped from the set falls back to the
   * service's own name, which is the behaviour a reader wants anyway — a half
   * translation is worse than none.
   */
  async setTranslations(args: {
    tenantId: string;
    serviceId: string;
    translations: ServiceTranslationInput[];
  }): Promise<ServiceWithTranslations> {
    const { tenantId, serviceId, translations } = args;

    await this.services.findByIdOrThrow({ tenantId, serviceId });

    const locales = translations.map((translation) => translation.locale);
    const duplicate = locales.find((locale, index) => locales.indexOf(locale) !== index);

    if (duplicate) {
      throw new ValidationError(`Locale ${duplicate} appears more than once.`, {
        field: "translations",
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.serviceTranslation.deleteMany({
        where: { serviceId, locale: { notIn: locales } },
      });

      for (const translation of translations) {
        const values = {
          name: translation.name,
          description: translation.description ?? null,
        };

        await tx.serviceTranslation.upsert({
          where: { serviceId_locale: { serviceId, locale: translation.locale } },
          update: values,
          create: { serviceId, locale: translation.locale, ...values },
        });
      }
    });

    return this.services.findByIdOrThrow({ tenantId, serviceId });
  }

  /**
   * Slugs are checked including archived services: an archived service may
   * still be linked from an old booking confirmation, and handing its URL to a
   * different service would send that customer somewhere unexpected.
   */
  private async assertSlugIsFree(args: { tenantId: string; slug: string }): Promise<void> {
    const existing = await this.services.findBySlug({ ...args, includeArchived: true });

    if (existing) {
      throw new ConflictError(
        ErrorCodes.SLUG_TAKEN,
        `The slug "${args.slug}" is already used by another service.`,
        { field: "slug", slug: args.slug },
      );
    }
  }
}

/**
 * Name → URL slug.
 *
 * Decomposes accents rather than stripping them, so "Fogkő-eltávolítás" becomes
 * "fogko-eltavolitas" instead of losing half its letters. Hungarian long
 * vowels (ő, ű) decompose to o and u, which is what a Hungarian reader would
 * type into a URL bar anyway.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}
