/* eslint-disable no-console -- CLI script; console is the output channel */
import { loadEnv } from "@bam/config";
import { createPrismaClient } from "../src/index.js";

/**
 * Delete an organization outright. **Development only.**
 *
 *   pnpm db:discard-organization <slug-or-domain>
 *   pnpm db:discard-organization <slug-or-domain> --yes
 *
 * ## Why this exists
 *
 * `slug` and `domain` are unique across *all* tenants, closed ones included, so
 * a test organization permanently blocks re-provisioning the same business.
 * Production solves that by reopening a closed prospect
 * (docs/phase-9-saas-administration.md §2.6.1); iterating on the onboarding
 * flow locally needs the blunter version — actually remove it, and go round
 * again.
 *
 * ## Why it is a script and not a route
 *
 * CLAUDE.md rule 7: no debug endpoints, in any environment. A route that
 * deletes tenants would be the most dangerous possible instance of the thing
 * that rule forbids — a predecessor shipped `/debug/db-info` to production, and
 * this would be far worse. A script has to be run deliberately, by someone with
 * the database URL, on a machine that is not production.
 *
 * ## What it deletes
 *
 * The tenant, and by cascade everything hanging off it: memberships,
 * invitations, outbox events, notifications, the subscription row, providers,
 * services, locations, bookings. Then any *user* left with no memberships at
 * all — because otherwise the second run of the onboarding loop hits "an
 * account already exists for that address" and the flow under test cannot be
 * re-entered.
 *
 * That last step is where the danger is, and it is worth reading twice: **a
 * platform admin holds no memberships by design** (rule 9). A naive "users with
 * no memberships" predicate deletes the operator account running the test.
 * `isPlatformAdmin: false` in that query is load-bearing.
 */
async function main(): Promise<void> {
  const [identifier, ...flags] = process.argv.slice(2);
  const confirmed = flags.includes("--yes");

  if (!identifier) {
    console.error(
      "Usage: pnpm db:discard-organization <slug-or-domain> [--yes]\n" +
        "Deletes an organization and everything belonging to it. Development only.",
    );
    process.exit(1);
  }

  const env = loadEnv();

  // First, before anything is read or written. The rest of this script assumes
  // it is safe to destroy data, and that assumption has exactly one precondition.
  if (env.NODE_ENV === "production") {
    console.error(
      "Refusing to run with NODE_ENV=production.\n" +
        "This script hard-deletes an organization. In production the equivalent is\n" +
        "closing it (phase-9 §2.6), which keeps the record of who was pitched.",
    );
    process.exit(1);
  }

  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });

  try {
    const needle = identifier.trim().toLowerCase();

    const tenant = await prisma.tenant.findFirst({
      where: { OR: [{ slug: needle }, { domain: needle }] },
      select: {
        id: true,
        name: true,
        slug: true,
        domain: true,
        status: true,
        memberships: {
          select: {
            role: true,
            user: { select: { id: true, email: true, isPlatformAdmin: true } },
          },
        },
        invitations: { select: { email: true, status: true } },
        _count: {
          select: { bookings: true, providers: true, services: true, locations: true },
        },
      },
    });

    if (!tenant) {
      console.error(`No organization with slug or domain "${identifier}".`);
      process.exit(1);
    }

    console.log(
      [
        `Organization : ${tenant.name}`,
        `Slug         : ${tenant.slug}`,
        `Domain       : ${tenant.domain ?? "(none)"}`,
        `Status       : ${tenant.status}`,
        `Members      : ${tenant.memberships.map((m) => `${m.user.email} (${m.role})`).join(", ") || "(none)"}`,
        `Invitations  : ${tenant.invitations.map((i) => `${i.email} [${i.status}]`).join(", ") || "(none)"}`,
        `Bookings     : ${String(tenant._count.bookings)}`,
        `Providers    : ${String(tenant._count.providers)}`,
        `Services     : ${String(tenant._count.services)}`,
        `Locations    : ${String(tenant._count.locations)}`,
      ].join("\n"),
    );

    if (!confirmed) {
      console.log("\nNothing deleted. Re-run with --yes to go ahead.");
      return;
    }

    // Candidates for removal *after* the tenant goes. Collected first, because
    // the membership rows that identify them are about to be cascaded away.
    //
    // Platform admins are excluded here rather than filtered later: they hold no
    // memberships by design, so they would otherwise match the "no memberships
    // left" test perfectly and be deleted — taking the operator account with the
    // test organization.
    const candidateUserIds = tenant.memberships
      .filter((m) => !m.user.isPlatformAdmin)
      .map((m) => m.user.id);

    await prisma.tenant.delete({ where: { id: tenant.id } });
    console.log(`\nDeleted organization ${tenant.slug}.`);

    const orphaned =
      candidateUserIds.length === 0
        ? []
        : await prisma.user.findMany({
            where: {
              id: { in: candidateUserIds },
              isPlatformAdmin: false,
              memberships: { none: {} },
            },
            select: { id: true, email: true },
          });

    if (orphaned.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: orphaned.map((u) => u.id) } } });
      console.log(
        `Deleted ${String(orphaned.length)} user(s) left with no memberships: ` +
          orphaned.map((u) => u.email).join(", "),
      );
    } else {
      console.log("No users left without memberships.");
    }

    console.log("\nThe slug and domain are free again; provision the same organization to retry.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
