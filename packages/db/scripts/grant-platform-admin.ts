/* eslint-disable no-console -- CLI script; console is the output channel */
import { loadEnv } from "@bam/config";
import { createPrismaClient } from "../src/index.js";

/**
 * Grant or revoke the platform-operator flag.
 *
 *   pnpm --filter @bam/db exec tsx scripts/grant-platform-admin.ts <email>
 *   pnpm --filter @bam/db exec tsx scripts/grant-platform-admin.ts <email> --revoke
 *
 * This script exists because `isPlatformAdmin` is declared to Better Auth with
 * `input: false`, so no sign-up, profile update or invitation can ever set it.
 * Deliberate, out-of-band, and auditable is the only way in — which is the
 * point: platform admin bypasses every tenant permission check (see
 * packages/auth/src/policy.ts).
 *
 * The user must already exist; sign them up through the normal flow first.
 */
async function main(): Promise<void> {
  const [email, ...flags] = process.argv.slice(2);
  const revoke = flags.includes("--revoke");

  if (!email) {
    console.error(
      "Usage: tsx scripts/grant-platform-admin.ts <email> [--revoke]\n" +
        "The user must already exist — sign them up through the app first.",
    );
    process.exit(1);
  }

  const env = loadEnv();
  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      console.error(`No user with email ${email}. Sign them up first, then re-run this.`);
      process.exit(1);
    }

    if (user.isPlatformAdmin === !revoke) {
      console.log(`${email} is already ${revoke ? "not " : ""}a platform admin. Nothing to do.`);
      return;
    }

    // Separation of duties, enforced from this side too. The API refuses to
    // give a platform admin a membership; without this check the same end state
    // is reachable by doing the two steps in the other order, which is how
    // one-way guards are usually defeated — not maliciously, just by working in
    // the order that seemed natural.
    //
    // The canonical rule, with its reasoning, is `canBecomePlatformAdmin` in
    // @bam/auth/policy.ts, and this is deliberately *not* importing it:
    // @bam/auth already depends on @bam/db for the Better Auth adapter, so the
    // import would make the two packages cyclic. What is duplicated is one
    // comparison; what matters — why the rule exists, and its counterpart
    // `canHoldTenantMembership` — stays in one place, and `policy.test.ts`
    // covers both sides.
    if (!revoke) {
      const membershipCount = await prisma.membership.count({ where: { userId: user.id } });

      if (membershipCount > 0) {
        const memberships = await prisma.membership.findMany({
          where: { userId: user.id },
          select: { role: true, tenant: { select: { slug: true } } },
        });

        console.error(
          `${email} belongs to ${String(membershipCount)} tenant(s) and cannot be a platform admin:\n` +
            memberships.map((m) => `  - ${m.tenant.slug} (${m.role})`).join("\n") +
            "\n\nA platform operator is not one of the platform's customers. Either remove those\n" +
            "memberships, or grant the flag to a separate account kept for platform work.",
        );
        process.exit(1);
      }
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { isPlatformAdmin: !revoke },
    });

    // Recorded in the same trail as every other privileged change, with
    // actorType SYSTEM because there is no request behind it.
    await prisma.auditLog.create({
      data: {
        actorType: "SYSTEM",
        actorId: null,
        action: revoke ? "user.platform_admin_revoked" : "user.platform_admin_granted",
        entityType: "User",
        entityId: user.id,
        beforeJson: { isPlatformAdmin: user.isPlatformAdmin },
        afterJson: { isPlatformAdmin: !revoke },
      },
    });

    console.log(`${revoke ? "Revoked" : "Granted"} platform admin for ${email}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
