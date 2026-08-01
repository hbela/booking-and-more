/* eslint-disable no-console -- CLI script; console is the output channel */
import { loadEnv } from "@bam/config";
import { createPrismaClient } from "../src/index.js";

/**
 * Give an existing user a membership in an existing tenant. Development only.
 *
 *   pnpm db:join-tenant <email> <tenant-slug> [ROLE] [--provider "Display Name"]
 *
 * Written for the demo seed, which built a clinic with no people in it. That
 * seed was removed on 2026-08-01 and an organization now arrives through the
 * platform-admin provisioning flow, which does create its owner — so the
 * original need is gone.
 *
 * It stays because the second membership is still awkward to come by: adding a
 * colleague means issuing and accepting an invitation, and testing a role that
 * is not OWNER should not require driving two mailboxes. `/v1/tenants` lists by
 * membership, exactly as it should, so an account with none sees nothing at all.
 *
 * This is the bridge, and it is deliberately a script rather than an API route:
 * granting yourself a membership is precisely what no endpoint may ever do
 * (CLAUDE.md rule 9). It refuses to run against production for the same reason
 * every other script here does.
 *
 * `--provider` additionally links the membership to a provider by display name,
 * which is what makes the `:own` permission paths testable — a PROVIDER whose
 * membership names no diary is refused everywhere, by design.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [email, slug] = args;
  const role = args.find((arg) => /^(OWNER|ADMIN|PROVIDER|ASSISTANT)$/.test(arg)) ?? "OWNER";
  const providerIndex = args.indexOf("--provider");
  const providerName = providerIndex === -1 ? undefined : args[providerIndex + 1];

  if (!email || !slug) {
    console.error(
      'Usage: pnpm db:join-tenant <email> <tenant-slug> [OWNER|ADMIN|PROVIDER|ASSISTANT] [--provider "Display Name"]\n' +
        "The user must already exist — sign them up through the app first.",
    );
    process.exit(1);
  }

  const env = loadEnv();

  if (env.NODE_ENV === "production") {
    console.error("Refusing to grant memberships in production.");
    process.exit(1);
  }

  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      console.error(`No user with email ${email}. Sign them up in the app first, then re-run.`);
      process.exit(1);
    }

    const tenant = await prisma.tenant.findUnique({ where: { slug } });
    if (!tenant) {
      console.error(
        `No tenant with slug ${slug}. Provision one through /platform first — ` +
          "there is no seeded tenant to join.",
      );
      process.exit(1);
    }

    let providerId: string | null = null;
    if (providerName !== undefined) {
      const provider = await prisma.provider.findFirst({
        where: { tenantId: tenant.id, displayName: providerName },
      });
      if (!provider) {
        console.error(`No provider called ${JSON.stringify(providerName)} in ${slug}.`);
        process.exit(1);
      }
      providerId = provider.id;
    }

    const membership = await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
      update: { role: role as "OWNER", status: "ACTIVE", providerId },
      create: {
        tenantId: tenant.id,
        userId: user.id,
        role: role as "OWNER",
        status: "ACTIVE",
        providerId,
        joinedAt: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        actorType: "SYSTEM",
        actorId: null,
        action: "membership.granted_by_script",
        entityType: "Membership",
        entityId: membership.id,
        afterJson: { role, providerId },
      },
    });

    console.log(
      `${email} is now ${role} of ${slug}${providerName === undefined ? "" : ` (linked to ${providerName})`}.`,
    );
    console.log("Sign out and back in, or switch tenants in the dashboard, to pick it up.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
