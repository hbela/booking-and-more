import {
  AppError,
  ErrorCodes,
  USAGE_UNITS,
  type UsageCategory,
  isWithinQuota,
  quotaFor,
  usagePeriodOf,
} from "@bam/contracts";
import { type Prisma, type PrismaClient } from "@bam/db";

import { UsageRepository, type UsageDb } from "./usage.repository.js";

/**
 * The gate, and the meter behind it. tech-impl §37 · PRD §11.
 *
 * docs/phase-7-chat-booking.md §9 is the argument for why this exists in the
 * same slice as the first paid call rather than after it: transcription and
 * interpretation are the first things in the product that cost money per request
 * and can be triggered by a stranger who has not signed in. Every earlier
 * variable cost is downstream of a booking, which is downstream of a hold, which
 * is downstream of availability. This one is downstream of nothing.
 */

/** What a metered call reports back once it has happened. */
export interface UsageRecord {
  tenantId: string;
  category: UsageCategory;
  /** Seconds, tokens or characters. Rounded up at the call site. */
  quantity: number;
  provider?: string | undefined;
  model?: string | undefined;
  estimatedCostMinor?: number | undefined;
  metadata?: Prisma.InputJsonValue | undefined;
}

export class UsageService {
  private readonly repository: UsageRepository;

  constructor(prisma: PrismaClient) {
    this.repository = new UsageRepository(prisma);
  }

  /**
   * Refuse the call before it is made.
   *
   * Called *before* the provider, never after — a check that runs afterwards is
   * an accounting entry, not a limit. The quantity is the one the caller is
   * about to spend, so a 30-second recording is refused when 20 seconds remain
   * rather than accepted and overshooting.
   *
   * Throws `USAGE_QUOTA_EXCEEDED` as a 429 rather than a 403: the tenant is not
   * forbidden from voice, they have used this month's allowance and next month
   * it works again. `report: false` because a customer hitting a documented
   * ceiling is expected behaviour and should not page anybody.
   */
  async assertAllowed(args: {
    tenantId: string;
    category: UsageCategory;
    requestedQuantity: number;
    now?: Date;
  }): Promise<void> {
    const period = usagePeriodOf(args.now ?? new Date());
    const plan = await this.repository.planOf(args.tenantId);

    const limit = quotaFor(plan, args.category);
    if (limit === null) return;

    const consumed = await this.repository.consumed({
      tenantId: args.tenantId,
      period,
      category: args.category,
    });

    const allowed = isWithinQuota({
      plan,
      category: args.category,
      consumed,
      requested: args.requestedQuantity,
    });

    if (allowed) return;

    throw new AppError(
      ErrorCodes.USAGE_QUOTA_EXCEEDED,
      "This month's assistant allowance has been used. You can still book using the form.",
      {
        statusCode: 429,
        report: false,
        // Enough for the panel to explain itself and fold away (PRD §12.4).
        // No provider, model or cost: what we pay is not the customer's business.
        details: { category: args.category, limit, consumed },
      },
    );
  }

  /**
   * Record what was actually spent.
   *
   * Takes an optional transaction handle so a caller that is already inside one
   * — the confirm path, for instance — meters and writes atomically. Without it
   * the repository opens its own, which still keeps the event and the aggregate
   * together.
   */
  async record(usage: UsageRecord, options: { db?: UsageDb; now?: Date } = {}): Promise<void> {
    await this.repository.record({
      tenantId: usage.tenantId,
      period: usagePeriodOf(options.now ?? new Date()),
      category: usage.category,
      quantity: usage.quantity,
      unit: USAGE_UNITS[usage.category],
      provider: usage.provider,
      model: usage.model,
      estimatedCostMinor: usage.estimatedCostMinor ?? 0,
      metadata: usage.metadata,
      ...(options.db === undefined ? {} : { db: options.db }),
    });
  }

  /**
   * What a tenant has used this period, for the owner's own screen later.
   *
   * Returns the allowance alongside the figure, because a number without its
   * ceiling tells nobody whether they are near it.
   */
  async summary(args: {
    tenantId: string;
    category: UsageCategory;
    now?: Date;
  }): Promise<{ period: string; consumed: number; limit: number | null }> {
    const period = usagePeriodOf(args.now ?? new Date());
    const plan = await this.repository.planOf(args.tenantId);

    const consumed = await this.repository.consumed({
      tenantId: args.tenantId,
      period,
      category: args.category,
    });

    return { period, consumed, limit: quotaFor(plan, args.category) };
  }
}
