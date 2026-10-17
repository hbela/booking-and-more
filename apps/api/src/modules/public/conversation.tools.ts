import { customerPiiFor } from "@bam/crypto";
import { toWallClock } from "@bam/availability-engine";
import type { ConversationIntent } from "@bam/contracts";
import {
  DEFAULT_SEARCH_WINDOW_DAYS,
  resolveDateExpression,
  type CollectedFields,
  type RefusalKey,
  type AssistantMessage,
} from "@bam/conversation-engine";
import type { PrismaClient, Service, ServiceTranslation, Tenant } from "@bam/db";

import { AvailabilityService } from "../availability/availability.service.js";
import { BookingService } from "../bookings/booking.service.js";
import { PublicCatalogueService, localiseService } from "./catalogue.service.js";
import type {
  ConfirmationCard,
  conversationProviderSchema,
  conversationServiceSchema,
  conversationSlotSchema,
  conversationSlotSearchSchema,
} from "./conversation.schemas.js";
import type { z } from "zod";

/**
 * The tool allowlist. tech-impl §23 · PRD §13.5 · docs/phase-7-chat-booking.md §6.
 *
 * A map from intent to handler. **Anything not in the map cannot run**, whatever
 * the model emits — which is what makes "a voice command cannot bypass
 * authorization" a property of the code rather than a hope about the prompt.
 * Every provider-side intent in `conversationIntentSchema` is absent here on
 * purpose; a declared intent with no handler is refused exactly like an unknown
 * one.
 *
 * Nothing in this file computes a slot, a span, a hold expiry or a snapshot.
 * Every handler is a thin call into the services the form path already uses,
 * with `publicOnly: true`, so the two paths cannot drift and the exclusion
 * constraint still decides who got the slot (rule 14).
 */

type ServiceRow = Service & { translations: ServiceTranslation[] };

export interface ToolContext {
  tenant: Tenant;
  conversationId: string;
  bookingId?: string | undefined;
  locale: string;
  timezone: string;
  collected: CollectedFields;
  parameters: Record<string, unknown>;
  /**
   * The customer's message exactly as sent. Read only to tell picking a service
   * apart from asking about one — see `listServices`.
   */
  utterance?: string | undefined;
  now: Date;
}

export interface ToolOutcome {
  message?: AssistantMessage;
  /** Merged into the conversation's collected fields. */
  collected?: Partial<CollectedFields>;
  /** Removed from them — a merge cannot unset ("anyone" after a name, or the reverse). */
  forget?: (keyof CollectedFields)[];
  services?: z.infer<typeof conversationServiceSchema>[];
  providers?: z.infer<typeof conversationProviderSchema>[];
  slots?: z.infer<typeof conversationSlotSchema>[];
  /** What the panel's calendar should search. Set by every search that ran, found or not. */
  slotSearch?: z.infer<typeof conversationSlotSearchSchema>;
  /** A prepared write, awaiting an explicit confirmation. */
  prepare?: {
    tool: ConfirmationCard["tool"];
    args: Record<string, unknown>;
    preview: Omit<ConfirmationCard, "actionId" | "expiresAt">;
  };
  /** Nothing went wrong, but the customer needs telling something. */
  refusal?: RefusalKey;
}

export type ToolHandler = (context: ToolContext) => Promise<ToolOutcome>;

export class ConversationTools {
  private readonly catalogue: PublicCatalogueService;
  private readonly availability: AvailabilityService;
  private readonly bookings: BookingService;

  constructor(private readonly prisma: PrismaClient) {
    this.catalogue = new PublicCatalogueService(prisma);
    this.availability = new AvailabilityService(prisma);
    this.bookings = new BookingService(prisma);
  }

  /**
   * The map. Read tools first, then the one that takes a hold, then the one that
   * prepares a write. There is no entry that confirms anything: confirmation is
   * a route with an action id in its path, never an intent the model can choose
   * (tech-impl §22.1).
   */
  handlers(): Partial<Record<ConversationIntent, ToolHandler>> {
    return {
      LIST_SERVICES: (context) => this.listServices(context),
      GET_SERVICE_DETAILS: (context) => this.listServices(context),
      GET_PROVIDER_DETAILS: (context) => this.listProviders(context),
      GET_LOCATION_DETAILS: (context) => this.locationDetails(context),
      SEARCH_SLOTS: (context) => this.searchSlots(context),
      SELECT_SLOT: (context) => this.selectSlot(context),
      CREATE_BOOKING: (context) => this.prepareBooking(context),
      GET_BOOKING: (context) => this.getBooking(context),
      RESCHEDULE_BOOKING: (context) => this.prepareReschedule(context),
      CANCEL_BOOKING: (context) => this.prepareCancellation(context),
    };
  }

  // --- Read tools -----------------------------------------------------------

  async locationDetails(context: ToolContext): Promise<ToolOutcome> {
    const locations = await this.prisma.location.findMany({
      where: { tenantId: context.tenant.id, active: true, archivedAt: null },
      orderBy: { name: "asc" },
      take: 25,
    });
    const answers = locations
      .map((location) => {
        if (location.type !== "PHYSICAL") {
          const remote =
            location.type === "ONLINE"
              ? context.locale === "hu"
                ? "Online konzultáció"
                : "Online consultation"
              : context.locale === "hu"
                ? "Telefonos konzultáció"
                : "Telephone consultation";
          return `${location.name}: ${remote}`;
        }
        const address = [
          [location.postalCode, location.city].filter(Boolean).join(" "),
          location.addressLine1,
          location.addressLine2,
          location.countryCode,
        ]
          .filter(Boolean)
          .join(", ");
        return address ? `${location.name}: ${address}` : "";
      })
      .filter(Boolean);
    const answer =
      answers.join("\n") ||
      (context.locale === "hu"
        ? "A pontos cím nincs megadva. Kérem, érdeklődjön közvetlenül a vállalkozásnál."
        : "The exact address has not been provided. Please contact the business directly.");
    return { message: { key: "conversation.answer", params: { answer }, ui: "NONE" } };
  }

  /**
   * The bookable services, or the one the customer picked.
   *
   * Picking and asking are different acts that reach this method through the
   * same intents: a tap on a service chip sends that service's name, and so does
   * "Is Consultation the only service?" — both arrive as `GET_SERVICE_DETAILS`
   * naming Consultation. Selecting on any single match once moved a customer who
   * had asked a question straight on to "Which day works for you?". So a single
   * match is a choice only when the caller says the customer is booking
   * (`SEARCH_SLOTS`) or when the whole message *is* the service's name; anything
   * else is answered in words, with the full list beside it.
   */
  async listServices(
    context: ToolContext,
    options: { booking?: boolean } = {},
  ): Promise<ToolOutcome> {
    const rows = await this.catalogue.listServices({ tenantId: context.tenant.id, limit: 25 });
    const query = stringParam(context.parameters, "serviceQuery", "query");
    const serviceId = stringParam(context.parameters, "serviceId");

    const matched =
      serviceId !== undefined
        ? rows.filter((row) => row.id === serviceId)
        : query === undefined
          ? rows
          : matchByName(rows, query, (row) => nameOf(row, context.locale));

    if ((query !== undefined || serviceId !== undefined) && matched.length === 1) {
      const only = matched[0]!;
      const picked =
        options.booking === true ||
        (context.utterance !== undefined &&
          fold(stripPunctuation(context.utterance)) === fold(nameOf(only, context.locale)));
      if (picked) {
        return {
          collected: { serviceId: only.id },
          services: [toServiceView(only, context.locale)],
        };
      }
    }

    // Booking from SEARCH_SLOTS without a usable service: the machine's own
    // "Which service would you like?" is the right next line, over the
    // narrowed list when the words matched several.
    if (options.booking === true) {
      return {
        services: (matched.length === 0 ? rows : matched).map((row) =>
          toServiceView(row, context.locale),
        ),
      };
    }

    const services = rows.map((row) => toServiceView(row, context.locale));

    const names = services.map((service) => service.name).join(", ");
    const notOffered = (query !== undefined || serviceId !== undefined) && matched.length === 0;

    let message: AssistantMessage;
    if (services.length === 0) {
      message = { key: "conversation.services.none", ui: "NONE" };
    } else if (notOffered && query !== undefined) {
      message = {
        key: "conversation.services.notOffered",
        params: { query, services: names },
        ui: "SERVICE_LIST",
      };
    } else if (services.length === 1) {
      message = {
        key: "conversation.services.only",
        params: { service: names },
        ui: "SERVICE_LIST",
      };
    } else {
      message = {
        key: "conversation.services.available",
        params: { services: names },
        ui: "SERVICE_LIST",
      };
    }

    return { message, services };
  }

  /**
   * Who the provider question offers: everyone who performs the service, as
   * the form lists them. The panel adds "anyone available" itself.
   */
  async providerChoices(
    tenantId: string,
    serviceId: string | undefined,
  ): Promise<z.infer<typeof conversationProviderSchema>[]> {
    const rows = await this.catalogue.listProviders({
      tenantId,
      limit: 25,
      ...(serviceId === undefined ? {} : { serviceId }),
    });
    return rows.map((row) => ({ id: row.id, displayName: row.displayName }));
  }

  async listProviders(context: ToolContext): Promise<ToolOutcome> {
    // "Anyone available" answers the provider question without naming anybody,
    // so it is recorded as an answer rather than inferred from an absence.
    // docs/phase-12-chat-slot-calendar.md §5.
    if (context.parameters["anyProvider"] === true) {
      return { collected: { anyProvider: true }, forget: ["providerId"] };
    }

    const rows = await this.catalogue.listProviders({
      tenantId: context.tenant.id,
      limit: 25,
      ...(context.collected.serviceId === undefined
        ? {}
        : { serviceId: context.collected.serviceId }),
    });

    const query = stringParam(context.parameters, "providerQuery", "query");
    const providerId = stringParam(context.parameters, "providerId");
    const matched =
      providerId !== undefined
        ? rows.filter((row) => row.id === providerId)
        : query === undefined
          ? rows
          : matchByName(rows, query, (row) => row.displayName);

    if ((query !== undefined || providerId !== undefined) && matched.length === 1) {
      const only = matched[0]!;
      return {
        collected: { providerId: only.id },
        forget: ["anyProvider"],
        providers: [{ id: only.id, displayName: only.displayName }],
      };
    }

    return {
      providers: (matched.length === 0 ? rows : matched).map((row) => ({
        id: row.id,
        displayName: row.displayName,
      })),
    };
  }

  /**
   * The slot search. Everything the customer said, resolved and handed to the
   * same `searchSlots` the form calls.
   */
  async searchSlots(context: ToolContext): Promise<ToolOutcome> {
    const collected: Partial<CollectedFields> = {};

    // A service named in words, resolved before anything else — a slot search
    // without one has nothing to search for.
    const serviceQuery = stringParam(context.parameters, "serviceQuery");
    const serviceId = stringParam(context.parameters, "serviceId") ?? context.collected.serviceId;

    if (serviceId === undefined && serviceQuery !== undefined) {
      const resolved = await this.listServices(context, { booking: true });
      if (resolved.collected?.serviceId === undefined) return resolved;
      collected.serviceId = resolved.collected.serviceId;
    } else if (serviceId !== undefined) {
      collected.serviceId = serviceId;
    }

    if (collected.serviceId === undefined) return this.listServices(context, { booking: true });

    const providerId =
      stringParam(context.parameters, "providerId") ?? context.collected.providerId;
    if (providerId !== undefined) collected.providerId = providerId;
    if (context.parameters["anyProvider"] === true) collected.anyProvider = true;

    const dates = resolveDateExpression({
      dateExpression: stringParam(context.parameters, "dateExpression"),
      timeExpression: stringParam(context.parameters, "timeExpression"),
      timezone: context.timezone,
      now: context.now,
      windowDays: DEFAULT_SEARCH_WINDOW_DAYS,
    });

    if (!dates.ok) return { collected, refusal: dates.reason };

    collected.dateFrom = dates.range.dateFrom;
    collected.dateTo = dates.range.dateTo;
    if (dates.range.timeFrom !== undefined) collected.timeFrom = dates.range.timeFrom;
    if (dates.range.timeTo !== undefined) collected.timeTo = dates.range.timeTo;

    // The form's order: nobody is offered a time before the provider question
    // is answered. A name in the same sentence answers it; otherwise the day
    // just resolved is kept, and decides where the calendar opens once they
    // have chosen. A reschedule never asks — its provider is the booking's.
    // docs/phase-12-chat-slot-calendar.md §5.
    if (
      collected.providerId === undefined &&
      collected.anyProvider !== true &&
      context.collected.anyProvider !== true &&
      context.bookingId === undefined
    ) {
      const chosen = await this.listProviders({
        ...context,
        collected: { ...context.collected, ...collected },
      });
      if (chosen.collected?.providerId === undefined) {
        return { collected, ...(chosen.providers ? { providers: chosen.providers } : {}) };
      }
      collected.providerId = chosen.collected.providerId;
    }

    // The calendar's search, from the same resolved ids. A single named day
    // opens the calendar on it; a range or no date leaves the choice to the
    // calendar's own first-available rule. docs/phase-12-chat-slot-calendar.md §2.2.
    const slotSearch = {
      serviceId: collected.serviceId,
      providerId: collected.providerId ?? null,
      date:
        dates.range.dateFrom === dates.range.dateTo && dates.range.assumption !== "DEFAULT_WINDOW"
          ? dates.range.dateFrom
          : null,
    };

    const slots = await this.availability.searchSlots({
      tenantId: context.tenant.id,
      input: {
        serviceId: collected.serviceId,
        ...(collected.providerId === undefined ? {} : { providerId: collected.providerId }),
        dateFrom: dates.range.dateFrom,
        dateTo: dates.range.dateTo,
        timezone: context.timezone,
      },
      now: context.now,
      publicOnly: true,
    });

    const withinPreference = slots.filter((slot) =>
      insideTimePreference(
        slot.startAt,
        context.timezone,
        dates.range.timeFrom,
        dates.range.timeTo,
      ),
    );

    // A time preference is a preference. Offering nothing because the customer
    // said "afternoon" and the only free slot is at 11 helps nobody; the widened
    // list is still ordered, so their preference is simply not first.
    const offered = (withinPreference.length > 0 ? withinPreference : slots).slice(0, 6);

    if (offered.length === 0) return { collected, slotSearch, refusal: "NO_SLOTS" };

    const names = await this.providerNames(
      context.tenant.id,
      offered.map((slot) => slot.providerId),
    );

    return {
      collected,
      slotSearch,
      slots: offered.map((slot) => ({
        providerId: slot.providerId,
        providerName: names.get(slot.providerId) ?? "",
        startAt: slot.startAt,
        endAt: slot.endAt,
      })),
    };
  }

  // --- Prepare tools --------------------------------------------------------

  /**
   * Take the hold.
   *
   * The conversation id is the hold's `sessionId` — the column's own comment
   * already anticipates "one browser tab or one conversation", and using it
   * means the release path, the ownership check and the sweep all work on a
   * conversational hold without a second concept.
   */
  async selectSlot(context: ToolContext): Promise<ToolOutcome> {
    const startAt = stringParam(context.parameters, "startAt") ?? context.collected.startAt;
    const providerId =
      stringParam(context.parameters, "providerId") ?? context.collected.providerId;
    const serviceId = context.collected.serviceId;

    // An ordinal ("the second one") is resolved by the caller against the list
    // it last showed — this handler only ever sees a resolved instant.
    if (startAt === undefined || providerId === undefined || serviceId === undefined) {
      return this.searchSlots(context);
    }

    if (context.bookingId !== undefined) {
      return this.prepareReschedule({ ...context, parameters: { ...context.parameters, startAt } });
    }

    const { hold } = await this.bookings.createHold({
      conversationId: context.conversationId,
      tenantId: context.tenant.id,
      input: {
        serviceId,
        providerId,
        ...(context.collected.locationId === undefined
          ? {}
          : { locationId: context.collected.locationId }),
        startAt,
        sessionId: context.conversationId,
      },
      now: context.now,
      publicOnly: true,
    });

    return {
      collected: {
        startAt: hold.startAt.toISOString(),
        providerId: hold.providerId,
        holdId: hold.id,
        ...(hold.locationId === null ? {} : { locationId: hold.locationId }),
      },
    };
  }

  /**
   * Build the confirmation card. tech-impl §23.2.
   *
   * Nothing is written here beyond the hold that already exists. What comes back
   * is what the customer will be shown and asked to agree to — an absolute date,
   * a named provider, a price — and the arguments that will be executed if they
   * do.
   */
  async prepareBooking(context: ToolContext): Promise<ToolOutcome> {
    const collected: Partial<CollectedFields> = {
      ...pickCustomer(context.parameters),
    };

    const merged = { ...context.collected, ...collected };

    if (
      merged.holdId === undefined ||
      merged.serviceId === undefined ||
      merged.providerId === undefined ||
      merged.startAt === undefined ||
      merged.fullName === undefined ||
      (merged.email === undefined && merged.phone === undefined)
    ) {
      // Still collecting. The state machine decides which question comes next.
      return { collected };
    }

    const hold = await this.bookings.getHold({
      tenantId: context.tenant.id,
      holdId: merged.holdId,
      sessionId: context.conversationId,
    });

    const [service, provider, location] = await Promise.all([
      this.catalogue.findService({ tenantId: context.tenant.id, serviceId: merged.serviceId }),
      this.catalogue.findProvider({ tenantId: context.tenant.id, providerId: merged.providerId }),
      hold.locationId === null
        ? Promise.resolve(null)
        : this.prisma.location.findFirst({
            where: { id: hold.locationId, tenantId: context.tenant.id },
            select: { name: true },
          }),
    ]);

    return {
      collected,
      prepare: {
        tool: "confirmBooking",
        args: {
          holdId: merged.holdId,
          customer: {
            fullName: merged.fullName,
            ...(merged.email === undefined ? {} : { email: merged.email }),
            ...(merged.phone === undefined ? {} : { phone: merged.phone }),
            preferredLanguage: context.locale,
          },
          ...(merged.notes === undefined ? {} : { notes: merged.notes }),
        },
        preview: {
          tool: "confirmBooking",
          serviceName: localiseService(service, context.locale).name,
          providerName: provider.displayName,
          locationName: location?.name ?? null,
          startAt: hold.startAt.toISOString(),
          endAt: hold.endAt.toISOString(),
          priceMinor: service.priceMinor,
          currency: service.currency,
          customerName: merged.fullName,
        },
      },
    };
  }

  async getBooking(context: ToolContext): Promise<ToolOutcome> {
    if (context.bookingId === undefined) return { refusal: "OUT_OF_SCOPE" };
    const booking = await this.bookings.repo.findByIdOrThrow({
      tenantId: context.tenant.id,
      bookingId: context.bookingId,
    });
    return {
      collected: {
        serviceId: booking.serviceId,
        providerId: booking.providerId,
        startAt: booking.startAt.toISOString(),
      },
    };
  }

  async prepareReschedule(context: ToolContext): Promise<ToolOutcome> {
    if (context.bookingId === undefined) return { refusal: "OUT_OF_SCOPE" };
    const booking = await this.bookings.repo.findByIdOrThrow({
      tenantId: context.tenant.id,
      bookingId: context.bookingId,
    });
    const startAt = stringParam(context.parameters, "startAt");
    if (startAt === undefined) {
      return this.searchSlots({
        ...context,
        collected: {
          ...context.collected,
          serviceId: booking.serviceId,
          providerId: booking.providerId,
        },
      });
    }
    const preview = await this.bookings.prepareReschedule({
      tenantId: context.tenant.id,
      bookingId: booking.id,
      input: { newStartAt: startAt },
      now: context.now,
    });
    if (!preview.decision.allowed) return { refusal: "SLOT_NO_LONGER_AVAILABLE" };
    return {
      prepare: {
        tool: "confirmReschedule",
        args: { bookingId: booking.id, newStartAt: preview.proposed.startAt },
        preview: {
          tool: "confirmReschedule",
          serviceName: booking.serviceNameSnapshot,
          providerName: booking.provider.displayName,
          locationName: booking.location?.name ?? null,
          startAt: preview.proposed.startAt,
          endAt: preview.proposed.endAt,
          priceMinor: booking.priceMinorSnapshot,
          currency: booking.currencySnapshot,
          customerName: customerPiiFor(this.prisma).open(booking.customerNameSnapshot),
        },
      },
    };
  }

  async prepareCancellation(context: ToolContext): Promise<ToolOutcome> {
    if (context.bookingId === undefined) return { refusal: "OUT_OF_SCOPE" };
    const preview = await this.bookings.prepareCancellation({
      tenantId: context.tenant.id,
      bookingId: context.bookingId,
      now: context.now,
    });
    if (!preview.decision.allowed) return { refusal: "OUT_OF_SCOPE" };
    const booking = preview.booking;
    return {
      prepare: {
        tool: "confirmCancellation",
        args: {
          bookingId: booking.id,
          ...(stringParam(context.parameters, "reason")
            ? { reason: stringParam(context.parameters, "reason") }
            : {}),
        },
        preview: {
          tool: "confirmCancellation",
          serviceName: booking.serviceNameSnapshot,
          providerName: booking.provider.displayName,
          locationName: booking.location?.name ?? null,
          startAt: booking.startAt.toISOString(),
          endAt: booking.endAt.toISOString(),
          priceMinor: booking.priceMinorSnapshot,
          currency: booking.currencySnapshot,
          customerName: customerPiiFor(this.prisma).open(booking.customerNameSnapshot),
        },
      },
    };
  }

  // --- Support --------------------------------------------------------------

  /** The catalogue the model is allowed to name. Ids and names, nothing else. */
  async catalogueFor(
    tenantId: string,
    locale: string,
  ): Promise<{
    services: { id: string; name: string }[];
    providers: { id: string; name: string }[];
    locations: { id: string; name: string }[];
  }> {
    const [services, providers, locations] = await Promise.all([
      this.catalogue.listServices({ tenantId, limit: 50 }),
      this.catalogue.listProviders({ tenantId, limit: 50 }),
      this.catalogue.listLocations(tenantId),
    ]);

    return {
      services: services.map((row) => ({ id: row.id, name: nameOf(row, locale) })),
      providers: providers.map((row) => ({ id: row.id, name: row.displayName })),
      locations: locations.map((row) => ({ id: row.id, name: row.name })),
    };
  }

  private async providerNames(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const rows = await this.prisma.provider.findMany({
      where: { tenantId, id: { in: [...new Set(ids)] } },
      select: { id: true, displayName: true },
    });

    return new Map(rows.map((row) => [row.id, row.displayName]));
  }
}

// ---------------------------------------------------------------------------
// Parameter and matching helpers
// ---------------------------------------------------------------------------

function stringParam(parameters: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parameters[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }

  return undefined;
}

/** The customer details an envelope may carry, and only those. */
function pickCustomer(parameters: Record<string, unknown>): Partial<CollectedFields> {
  const fields: Partial<CollectedFields> = {};

  const fullName = stringParam(parameters, "fullName");
  const email = stringParam(parameters, "email");
  const phone = stringParam(parameters, "phone");
  const notes = stringParam(parameters, "notes");

  if (fullName !== undefined) fields.fullName = fullName;
  if (email !== undefined) fields.email = email;
  if (phone !== undefined) fields.phone = phone;
  if (notes !== undefined) fields.notes = notes;

  return fields;
}

function nameOf(service: ServiceRow, locale: string): string {
  return localiseService(service, locale).name;
}

/**
 * A service as the panel renders it.
 *
 * The localised name, the duration and the price — the three things a customer
 * choosing between services needs, and nothing the staff schema carries.
 */
function toServiceView(
  service: ServiceRow,
  locale: string,
): z.infer<typeof conversationServiceSchema> {
  return {
    id: service.id,
    name: nameOf(service, locale),
    durationMinutes: service.durationMinutes,
    priceMinor: service.priceMinor,
    currency: service.currency,
  };
}

/**
 * Match a spoken name against the catalogue.
 *
 * Accent-insensitive substring matching in both directions, so "kontroll"
 * matches "Fogászati kontroll" and "fogaszati kontrol vizsgalat" still finds it.
 * Deliberately not fuzzy: a wrong service booked confidently is worse than a
 * question, and the ambiguous case falls back to showing the list.
 */
function matchByName<T>(rows: T[], query: string, nameFor: (row: T) => string): T[] {
  const needle = fold(query);
  if (needle === "") return rows;

  const exact = rows.filter((row) => fold(nameFor(row)) === needle);
  if (exact.length > 0) return exact;

  return rows.filter((row) => {
    const name = fold(nameFor(row));
    return name.includes(needle) || needle.includes(name);
  });
}

/** A tapped or typed name may arrive with a full stop or a question mark. */
function stripPunctuation(value: string): string {
  return value.replace(/[\s.!?,;:…]+$/u, "");
}

function fold(value: string): string {
  return value
    .toLocaleLowerCase("hu")
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Is this slot inside the customer's preferred part of the day?
 *
 * Compared as a wall-clock reading in the conversation's zone, never by
 * arithmetic on the instant — rule 13, and the reason `zone.ts` is the only
 * place allowed to answer "what time is it there".
 */
function insideTimePreference(
  startAt: string,
  timezone: string,
  from: number | undefined,
  to: number | undefined,
): boolean {
  if (from === undefined || to === undefined) return true;

  const wall = toWallClock(Date.parse(startAt), timezone);
  const minute = wall.hour * 60 + wall.minute;

  return minute >= from && minute < to;
}

export { fold as foldForMatching, matchByName };
