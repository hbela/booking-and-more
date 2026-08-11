import {
  type Prisma,
  type PrismaClient,
  type UsageCategory as PrismaUsageCategory,
} from "@bam/db";

/**
 * Reads and writes of the two metering tables. tech-impl §37.
 *
 * Every method takes `tenantId` explicitly (rule 5) and accepts a transaction
 * client, because the whole point of the aggregate is that it moves in the same
 * transaction as the event that caused it.
 */

/** Prisma's client or a transaction handle. */
export type UsageDb = PrismaClient | Prisma.TransactionClient;

export class UsageRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The plan a tenant's quota is read against.
   *
   * `null` when the tenant has no subscription row at all, which phase-9 §2.2's
   * invariant says should not happen for an ACTIVE organization but which is
   * still reachable — a tenant provisioned and never subscribed. `quotaFor`
   * turns that into the STARTER allowance rather than into no allowance.
   */
  async planOf(tenantId: string): Promise<string | null> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { tenantId },
      select: { plan: true },
    });

    return subscription?.plan ?? null;
  }

  /** How much of an allowance this period has already used. Zero if untouched. */
  async consumed(args: {
    tenantId: string;
    period: string;
    category: PrismaUsageCategory;
    db?: UsageDb;
  }): Promise<number> {
    const db = args.db ?? this.prisma;

    const aggregate = await db.usageAggregate.findUnique({
      where: {
        tenantId_period_category: {
          tenantId: args.tenantId,
          period: args.period,
          category: args.category,
        },
      },
      select: { quantity: true },
    });

    return aggregate?.quantity ?? 0;
  }

  /**
   * Write the event and move the aggregate, atomically.
   *
   * The `increment` is the important part: two concurrent transcriptions for the
   * same tenant must add up rather than race to write the same total. Prisma
   * compiles it to `SET quantity = quantity + $1`, which PostgreSQL serialises
   * on the row lock.
   */
  async record(args: {
    tenantId: string;
    period: string;
    category: PrismaUsageCategory;
    quantity: number;
    unit: string;
    provider?: string | undefined;
    model?: string | undefined;
    estimatedCostMinor: number;
    metadata?: Prisma.InputJsonValue | undefined;
    db?: UsageDb;
  }): Promise<void> {
    const run = async (db: UsageDb): Promise<void> => {
      await db.usageEvent.create({
        data: {
          tenantId: args.tenantId,
          category: args.category,
          quantity: args.quantity,
          unit: args.unit,
          ...(args.provider === undefined ? {} : { provider: args.provider }),
          ...(args.model === undefined ? {} : { model: args.model }),
          estimatedCostMinor: args.estimatedCostMinor,
          ...(args.metadata === undefined ? {} : { metadataJson: args.metadata }),
        },
      });

      await db.usageAggregate.upsert({
        where: {
          tenantId_period_category: {
            tenantId: args.tenantId,
            period: args.period,
            category: args.category,
          },
        },
        create: {
          tenantId: args.tenantId,
          period: args.period,
          category: args.category,
          quantity: args.quantity,
          estimatedCostMinor: args.estimatedCostMinor,
        },
        update: {
          quantity: { increment: args.quantity },
          estimatedCostMinor: { increment: args.estimatedCostMinor },
        },
      });
    };

    if (args.db) {
      await run(args.db);
      return;
    }

    await this.prisma.$transaction(run);
  }
}
