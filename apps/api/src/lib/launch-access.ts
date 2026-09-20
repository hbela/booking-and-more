import type { FastifyInstance } from "fastify";
import { ForbiddenError } from "@bam/contracts";
export interface LaunchAccessOptions {
  mode: "invite_only" | "public";
  ownerEmails: string[];
}
export async function assertLaunchAccess(
  app: FastifyInstance,
  userId: string,
  options: LaunchAccessOptions,
): Promise<void> {
  if (options.mode === "public") return;
  // Read current verification state, not Better Auth's cached session snapshot.
  const user = await app.prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (!user || !options.ownerEmails.includes(user.email.trim().toLowerCase())) {
    throw new ForbiddenError(
      "Business onboarding is currently invitation-only. Contact support for access.",
    );
  }
  if (!user.emailVerified)
    throw new ForbiddenError(
      "Verify your email before creating an organization or starting checkout. You can resend verification from your account.",
    );
}
