import { createHash } from "node:crypto";
import {
  conversationUnavailable,
  tokenCostMinor,
  type AiUsage,
  type ImportPart,
  type AuditText,
  type KnowledgeAssistant,
} from "@bam/ai";
import {
  AppError,
  ErrorCodes,
  languageSchema,
  NotFoundError,
  ValidationError,
  type KnowledgeAudit,
  type SiteImportDraft,
  type TranslationDraft,
  type TranslationDraftRequest,
} from "@bam/contracts";
import type { PrismaClient } from "@bam/db";
import type { KnowledgeText } from "@bam/knowledge-engine";
import { UsageService } from "../usage/usage.service.js";
import { AssistantService, localizedBusinessDescriptionWithLocale } from "./assistant.service.js";
import { knowledgeSnapshot } from "./knowledge-health.js";
import { readSite, SiteReadError, type SiteFetcher, type SitePage } from "./site-reader.js";

/** The chat's monthly token ceilings, so these calls spend the same allowance. */
export interface KnowledgeAiLimits {
  professionalMonthlyLimit: number;
  plusMonthlyLimit: number;
  maxInputTokens: number;
  maxConversationOutputTokens: number;
}

const AUDIT_MAX_OUTPUT_TOKENS = 4_096;
const TRANSLATION_MAX_OUTPUT_TOKENS = 16_000;
/**
 * Per half of the import (docs/phase-12-site-import.md §8). Measured on
 * koronafogaszat.eu: the whole answer was 9 013 tokens, about 3 500 of them
 * the profile and FAQs and 5 500 the forty services.
 */
const IMPORT_PROFILE_MAX_OUTPUT_TOKENS = 6_000;
const IMPORT_SERVICES_MAX_OUTPUT_TOKENS = 10_000;

/** Enough of a logger to say why a model call failed, without its content. */
export interface KnowledgeAiLog {
  warn(details: Record<string, unknown>, message: string): void;
}
const CACHE_SIZE = 200;
/**
 * A text longer than this is split at blank lines, and pieces are batched up
 * to the second figure per call, so a 30 000-character profile becomes several
 * parallel calls of about 40 s rather than one that outruns the model timeout
 * (docs/phase-12-knowledge-allowance-and-prompt-caching.md §3.4).
 */
const TRANSLATION_PIECE_CHARACTERS = 4_000;
const TRANSLATION_BATCH_CHARACTERS = 6_000;

/**
 * phase-12 part 4: the model-assisted audit (§3.2) and translation drafts (§8.4).
 *
 * Both are owner-triggered and paid, so both go through the same
 * reserve → call → reconcile sequence as a chat turn: the upper bound is
 * reserved before the provider is called, refused when the month's allowance
 * cannot cover it, and settled to what the provider reports. A failed call
 * settles the whole reservation — the provider may have charged for it.
 *
 * Neither writes tenant data. An audit is advice; a draft is text the owner
 * saves through the ordinary editors, or does not.
 */
export class KnowledgeAiService {
  private readonly usage: UsageService;
  /**
   * Audits by snapshot hash, so pressing the button twice costs once. In
   * process memory rather than a table: losing it on a restart costs one more
   * call, and a stale entry cannot exist because the key is the content.
   */
  private readonly audits = new Map<string, Omit<KnowledgeAudit, "cached">>();
  /** Site imports by a hash of the pages read, for the same reason. */
  private readonly imports = new Map<string, Omit<SiteImportDraft, "cached">>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly model: KnowledgeAssistant,
    private readonly limits: KnowledgeAiLimits,
    private readonly siteFetcher: SiteFetcher,
    private readonly log?: KnowledgeAiLog,
  ) {
    this.usage = new UsageService(prisma);
  }

  async audit(tenantId: string, locale: string): Promise<KnowledgeAudit> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const [snapshot, context] = await Promise.all([
      knowledgeSnapshot(this.prisma, tenantId),
      new AssistantService(this.prisma).knowledgeContext(tenant, tenant.defaultLanguage),
    ]);
    if (snapshot.texts.length === 0) return { findings: [], discarded: 0, cached: false };

    const texts: AuditText[] = snapshot.texts.map((text, index) => ({
      ref: `t${String(index)}`,
      label: label(text),
      text: text.text,
    }));
    const input = { facts: context.bookableFacts, texts, locale };
    const key = createHash("sha256")
      .update(JSON.stringify([tenantId, input]))
      .digest("hex");
    const hit = this.audits.get(key);
    if (hit) return { ...hit, cached: true };

    const { findings } = await this.metered(
      tenantId,
      () => this.model.countAuditTokens(input),
      AUDIT_MAX_OUTPUT_TOKENS,
      () => this.model.audit(input, AUDIT_MAX_OUTPUT_TOKENS),
    );

    // An excerpt that is not in the text it names was invented, and an invented
    // contradiction is worse than a missed one (phase-12 §3.2).
    const byRef = new Map(texts.map((text, index) => [text.ref, snapshot.texts[index]!]));
    const verified = findings.flatMap((finding) => {
      const source = byRef.get(finding.ref);
      if (!source || !finding.excerpt.trim() || !contains(source.text, finding.excerpt)) return [];
      return [
        {
          severity: finding.severity,
          source: { kind: source.kind, id: source.id, name: source.name, locale: source.locale },
          excerpt: finding.excerpt.trim(),
          explanation: finding.explanation.trim(),
        },
      ];
    });
    const result = { findings: verified, discarded: findings.length - verified.length };
    if (this.audits.size >= CACHE_SIZE) this.audits.delete(this.audits.keys().next().value!);
    this.audits.set(key, result);
    return { ...result, cached: false };
  }

  async translationDraft(
    tenantId: string,
    args: TranslationDraftRequest,
  ): Promise<TranslationDraft> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { defaultLanguage: true },
    });
    const source = languageSchema.parse(tenant.defaultLanguage);
    const target = languageSchema.parse(args.target);
    if (target === source)
      throw new ValidationError("The default language is the one translated from.", {
        field: "target",
      });

    const items: { id: string; text: string }[] = [];
    let faqs: { id: string; question: string; answer: string }[] = [];
    if (args.kind === "SERVICE") {
      // `services.name` and `.description` are the default language; the
      // other locales are ServiceTranslation rows (tech-impl §38).
      const service = await this.prisma.service.findFirst({
        where: { id: args.serviceId, tenantId },
        select: { name: true, description: true },
      });
      if (!service) throw new NotFoundError("Service not found.", ErrorCodes.SERVICE_NOT_FOUND);
      items.push({ id: "service:service-name", text: service.name });
      if (service.description?.trim())
        items.push({ id: "service:description", text: service.description });
    } else if (args.kind === "PROFILE") {
      const settings = await this.prisma.tenantAssistantSettings.findUnique({
        where: { tenantId },
      });
      const profile = localizedBusinessDescriptionWithLocale(settings, source, source);
      if (profile) items.push({ id: "profile", text: profile.text });
    } else {
      faqs = await this.prisma.tenantAssistantFaq.findMany({
        where: { tenantId, locale: source, active: true },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        select: { id: true, question: true, answer: true },
      });
      for (const faq of faqs) {
        items.push({ id: `${faq.id}:q`, text: faq.question });
        items.push({ id: `${faq.id}:a`, text: faq.answer });
      }
    }
    if (items.length === 0)
      throw new ValidationError("There is nothing in the default language to translate.", {
        field: "kind",
      });

    const pieces = new Map(
      items.map((item) => [item.id, splitForTranslation(item.text, TRANSLATION_PIECE_CHARACTERS)]),
    );
    const batches = batchPieces(
      items.flatMap((item) =>
        pieces.get(item.id)!.map((piece, index, all) => ({
          id: all.length === 1 ? item.id : `${item.id}#${String(index)}`,
          text: piece,
        })),
      ),
      TRANSLATION_BATCH_CHARACTERS,
    );
    const translated = await Promise.all(
      batches.map((batch) => {
        const input = { from: source, to: target, items: batch };
        const characters = batch.reduce((sum, item) => sum + item.text.length, 0);
        const maxOutput = Math.min(TRANSLATION_MAX_OUTPUT_TOKENS, Math.ceil(characters / 2) + 512);
        return this.metered(
          tenantId,
          () => this.model.countTranslateTokens(input),
          maxOutput,
          () => this.model.translate(input, maxOutput),
          "translation_draft",
        );
      }),
    );

    const returned = new Map(
      translated.flatMap((result) => result.items.map((item) => [item.id, item.text.trim()])),
    );
    // A draft missing a piece would be saved by an owner who did not notice;
    // all or nothing — and that holds for each piece of a split text too.
    const text = new Map<string, string>();
    for (const item of items) {
      const count = pieces.get(item.id)!.length;
      const parts =
        count === 1
          ? [returned.get(item.id)]
          : Array.from({ length: count }, (_, index) =>
              returned.get(`${item.id}#${String(index)}`),
            );
      if (parts.some((part) => !part)) throw conversationUnavailable();
      text.set(item.id, parts.join("\n\n"));
    }
    return {
      source,
      target,
      kind: args.kind,
      profile: args.kind === "PROFILE" ? text.get("profile")! : null,
      faqs: faqs.map((faq) => ({
        sourceId: faq.id,
        question: text.get(`${faq.id}:q`)!,
        answer: text.get(`${faq.id}:a`)!,
      })),
      service:
        args.kind === "SERVICE"
          ? {
              name: text.get("service:service-name")!,
              description: text.get("service:description") ?? null,
            }
          : null,
    };
  }

  /**
   * docs/phase-12-site-import.md: drafts from the organization's own website.
   *
   * Only `tenants.domain` is read — never a URL the caller supplies — so the
   * site is the organization's by provisioning, and this is not a general URL
   * fetcher. Nothing is written: the owner saves each piece through its
   * ordinary editor, where the knowledge budget and the consistency check
   * apply as they do to typed text.
   */
  async siteImportDraft(tenantId: string): Promise<SiteImportDraft> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, domain: true, defaultLanguage: true },
    });
    if (!tenant.domain)
      throw new ValidationError("The organization has no website domain on record.", {
        field: "domain",
      });
    const domain = tenant.domain;
    const language = languageSchema.parse(tenant.defaultLanguage);

    let pages: SitePage[];
    try {
      pages = await readSite(domain, this.siteFetcher);
    } catch (error) {
      const reason = error instanceof SiteReadError ? error.reason : "unreachable";
      throw new AppError(ErrorCodes.SITE_UNREACHABLE, "The website could not be read.", {
        statusCode: 422,
        details: { field: "domain", reason },
        report: false,
      });
    }

    const input = { language, businessName: tenant.name, pages };
    const key = createHash("sha256")
      .update(JSON.stringify([tenantId, input]))
      .digest("hex");
    const hit = this.imports.get(key);
    if (hit) return { ...hit, cached: true };

    // Two halves in parallel, each within its own cap: one call for everything
    // ran past its output limit on a real price list (§8).
    const half = (part: ImportPart, maxOutput: number) => {
      const partInput = { ...input, part };
      return this.metered(
        tenantId,
        () => this.model.countImportTokens(partInput),
        maxOutput,
        () => this.model.importFromSite(partInput, maxOutput),
        `site_import.${part.toLowerCase()}`,
      );
    };
    const [profileHalf, servicesHalf] = await Promise.all([
      half("PROFILE_AND_FAQS", IMPORT_PROFILE_MAX_OUTPUT_TOKENS),
      half("SERVICES", IMPORT_SERVICES_MAX_OUTPUT_TOKENS),
    ]);
    const draft = {
      profile: profileHalf.draft.profile,
      faqs: profileHalf.draft.faqs,
      services: servicesHalf.draft.services,
    };

    // A proposal is kept only when it names what the site says, from a page
    // that was read — the same posture as the audit's verbatim excerpts. An
    // invented treatment would otherwise reach the catalogue one click later.
    const read = new Set(pages.map((page) => page.url));
    const corpus = normalise(pages.map((page) => `${page.title ?? ""}\n${page.text}`).join("\n"));
    const existing = await this.prisma.service.findMany({
      where: { tenantId, archivedAt: null },
      select: { id: true, name: true },
    });
    const byName = new Map(existing.map((service) => [normalise(service.name), service.id]));
    const seen = new Set<string>();
    const services = draft.services.flatMap((service) => {
      const name = normalise(service.name);
      if (!read.has(service.sourceUrl) || !corpus.includes(name) || seen.has(name)) return [];
      seen.add(name);
      return [{ ...service, existingServiceId: byName.get(name) ?? null }];
    });
    const faqs = draft.faqs.filter((faq) => read.has(faq.sourceUrl));
    const result = {
      domain,
      language,
      pages: pages.map((page) => ({ url: page.url, title: page.title })),
      profile: draft.profile || null,
      services,
      faqs,
      discarded: draft.services.length - services.length + (draft.faqs.length - faqs.length),
    };
    if (this.imports.size >= CACHE_SIZE) this.imports.delete(this.imports.keys().next().value!);
    this.imports.set(key, result);
    return { ...result, cached: false };
  }

  /** Reserve the upper bound, call, settle what was used (see the class comment). */
  private async metered<T extends { usage: AiUsage }>(
    tenantId: string,
    count: () => Promise<number>,
    maxOutputTokens: number,
    call: () => Promise<T>,
    operation = "knowledge",
  ): Promise<T> {
    let counted: number;
    try {
      counted = await count();
    } catch (error) {
      this.log?.warn(
        { operation, stage: "count", error: errorName(error) },
        "Knowledge model call failed",
      );
      throw conversationUnavailable();
    }
    const reservedInput = Math.ceil((counted * 110) / 100);
    const subscription = await this.prisma.subscription.findUnique({
      where: { tenantId },
      select: { plan: true },
    });
    const monthly =
      subscription?.plan === "PROFESSIONAL_PLUS"
        ? this.limits.plusMonthlyLimit
        : this.limits.professionalMonthlyLimit;
    const reservationId = await this.usage.reserveAiCall({
      tenantId,
      inputTokens: reservedInput,
      outputTokens: maxOutputTokens,
      inputLimit: monthly * this.limits.maxInputTokens,
      outputLimit: monthly * this.limits.maxConversationOutputTokens,
    });

    let result: T;
    try {
      result = await call();
    } catch (error) {
      // A truncated answer reports what it used; settle that. Anything else
      // settles the whole reservation, because the provider may have charged.
      const failed = error as { usage?: AiUsage; failure?: string };
      this.log?.warn(
        {
          operation,
          stage: "call",
          failure: failed.failure ?? errorName(error),
          maxOutputTokens,
          outputTokens: failed.usage?.outputTokens,
        },
        "Knowledge model call failed",
      );
      await this.usage.reconcileAiCall({
        tenantId,
        reservationId,
        inputTokens: failed.usage?.inputTokens ?? reservedInput,
        outputTokens: failed.usage?.outputTokens ?? maxOutputTokens,
        provider: failed.usage?.provider ?? "anthropic",
        model: failed.usage?.model ?? "unknown",
        estimatedCostMinor:
          failed.usage?.estimatedCostMinor ??
          tokenCostMinor({
            model: "unknown",
            inputTokens: reservedInput,
            outputTokens: maxOutputTokens,
          }),
      });
      throw conversationUnavailable();
    }
    await this.usage.reconcileAiCall({
      tenantId,
      reservationId,
      inputTokens: result.usage.inputTokens ?? reservedInput,
      outputTokens: result.usage.outputTokens ?? maxOutputTokens,
      provider: result.usage.provider,
      model: result.usage.model,
      estimatedCostMinor: result.usage.estimatedCostMinor,
    });
    return result;
  }
}

/** The kind of failure only; a provider message may quote the request. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function label(text: KnowledgeText): string {
  if (text.kind === "PROFILE") return `Company profile (${text.locale})`;
  if (text.kind === "SERVICE") return `Service description: ${text.name ?? ""} (${text.locale})`;
  return `FAQ: ${text.name ?? ""} (${text.locale})`;
}

/**
 * Pieces of at most `limit` characters, split at blank lines; a paragraph that
 * is longer on its own is split at line breaks, then sentence ends, then cut.
 */
export function splitForTranslation(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const pieces: string[] = [];
  let current = "";
  const push = (unit: string, separator: string) => {
    if (current && current.length + separator.length + unit.length > limit) {
      pieces.push(current);
      current = "";
    }
    current = current ? `${current}${separator}${unit}` : unit;
  };
  for (const paragraph of text.split(/\n{2,}/u)) {
    if (paragraph.length <= limit) {
      push(paragraph, "\n\n");
      continue;
    }
    // Too long for one piece: smaller units, glued back with what split them.
    // It starts a piece of its own, since its first unit carries no separator;
    // reassembly joins pieces with a blank line, so a paragraph this long (rare)
    // comes back as several.
    if (current) pieces.push(current);
    current = "";
    for (const unit of paragraph.split(/(?<=\n)|(?<=[.!?]\s)/u)) {
      for (let start = 0; start < unit.length; start += limit) {
        push(unit.slice(start, start + limit), "");
      }
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Greedy batches of at most `limit` characters; an item longer than that rides alone. */
function batchPieces<T extends { text: string }>(items: T[], limit: number): T[][] {
  const batches: T[][] = [];
  let size = 0;
  for (const item of items) {
    const last = batches.at(-1);
    if (last && size + item.text.length <= limit) {
      last.push(item);
      size += item.text.length;
    } else {
      batches.push([item]);
      size = item.text.length;
    }
  }
  return batches;
}

/** Case- and whitespace-insensitive, for matching names. Accents count. */
function normalise(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("hu").replace(/\s+/gu, " ").trim();
}

/** Whitespace-insensitive, because a model reflows line breaks inside a quote. */
function contains(text: string, excerpt: string): boolean {
  const squash = (value: string) => value.replace(/\s+/gu, " ").trim();
  return squash(text).includes(squash(excerpt));
}
