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

  constructor(private readonly prisma: PrismaClient) {
    this.repository = new UsageRepository(prisma);
  }

  /** Atomically reserve both sides of one paid model call. */
  async reserveAiCall(args: {
    tenantId: string;
    inputTokens: number;
    outputTokens: number;
    now?: Date;
  }): Promise<string | null> {
    const now = args.now ?? new Date();
    const period = usagePeriodOf(now);
    const plan = await this.repository.planOf(args.tenantId);
    const inputLimit = quotaFor(plan, "AI_INPUT_TOKENS");
    const outputLimit = quotaFor(plan, "AI_OUTPUT_TOKENS");
    if (inputLimit === null && outputLimit === null) return null;

    return this.prisma.$transaction(async (tx) => {
      // A transaction-scoped lock makes the read-plus-create decision one
      // serial operation per tenant/month, including when no aggregate exists.
      const lockKey = `assistant-quota:${args.tenantId}:${period}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      await tx.usageReservation.updateMany({
        where: { tenantId: args.tenantId, period, status: "RESERVED", expiresAt: { lte: now } },
        data: { status: "EXPIRED" },
      });

      const [inputAggregate, outputAggregate, reserved] = await Promise.all([
        tx.usageAggregate.findUnique({
          where: {
            tenantId_period_category: {
              tenantId: args.tenantId,
              period,
              category: "AI_INPUT_TOKENS",
            },
          },
          select: { quantity: true },
        }),
        tx.usageAggregate.findUnique({
          where: {
            tenantId_period_category: {
              tenantId: args.tenantId,
              period,
              category: "AI_OUTPUT_TOKENS",
            },
          },
          select: { quantity: true },
        }),
        tx.usageReservation.aggregate({
          where: { tenantId: args.tenantId, period, status: "RESERVED", expiresAt: { gt: now } },
          _sum: { inputTokens: true, outputTokens: true },
        }),
      ]);

      const inputConsumed = (inputAggregate?.quantity ?? 0) + (reserved._sum.inputTokens ?? 0);
      const outputConsumed = (outputAggregate?.quantity ?? 0) + (reserved._sum.outputTokens ?? 0);
      const inputAllowed = inputLimit === null || inputConsumed + args.inputTokens <= inputLimit;
      const outputAllowed =
        outputLimit === null || outputConsumed + args.outputTokens <= outputLimit;
      if (!inputAllowed || !outputAllowed) {
        throw new AppError(
          ErrorCodes.USAGE_QUOTA_EXCEEDED,
          "This month's assistant allowance has been used. You can still book using the form.",
          { statusCode: 429, report: false },
        );
      }

      const reservation = await tx.usageReservation.create({
        data: {
          tenantId: args.tenantId,
          period,
          inputTokens: args.inputTokens,
          outputTokens: args.outputTokens,
          expiresAt: new Date(now.getTime() + 5 * 60_000),
        },
        select: { id: true },
      });
      return reservation.id;
    });
  }

  async reconcileAiCall(args: {
    tenantId: string;
    reservationId: string | null;
    inputTokens: number;
    outputTokens: number;
    provider: string;
    model: string;
    estimatedCostMinor: number;
    now?: Date;
  }): Promise<void> {
    const now = args.now ?? new Date();
    await this.prisma.$transaction(async (tx) => {
      if (args.reservationId !== null) {
        const claimed = await tx.usageReservation.updateMany({
          where: { id: args.reservationId, tenantId: args.tenantId, status: "RESERVED" },
          data: { status: "SETTLED", settledAt: now },
        });
        if (claimed.count !== 1) return;
      }
      await this.repository.record({
        tenantId: args.tenantId,
        period: usagePeriodOf(now),
        category: "AI_INPUT_TOKENS",
        quantity: args.inputTokens,
        unit: USAGE_UNITS.AI_INPUT_TOKENS,
        provider: args.provider,
        model: args.model,
        estimatedCostMinor: args.estimatedCostMinor,
        db: tx,
      });
      await this.repository.record({
        tenantId: args.tenantId,
        period: usagePeriodOf(now),
        category: "AI_OUTPUT_TOKENS",
        quantity: args.outputTokens,
        unit: USAGE_UNITS.AI_OUTPUT_TOKENS,
        provider: args.provider,
        model: args.model,
        estimatedCostMinor: 0,
        db: tx,
      });
    });
  }

  async releaseAiReservation(tenantId: string, reservationId: string | null): Promise<void> {
    if (reservationId === null) return;
    await this.prisma.usageReservation.updateMany({
      where: { id: reservationId, tenantId, status: "RESERVED" },
      data: { status: "RELEASED" },
    });
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
