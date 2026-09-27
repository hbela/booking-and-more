import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "@bam/contracts";
import { closeConversation, type ConversationSession, type PrismaClient } from "@bam/db";

export interface ChatLimits {
  dailyLimit: number;
  professionalMonthlyLimit: number;
  plusMonthlyLimit: number;
  maxMessageCharacters: number;
  maxPatientCharacters: number;
  maxInputTokens: number;
  maxConversationOutputTokens: number;
  sessionRateLimit: number;
  startRateLimit: number;
  messageRateLimit: number;
  tokenSigningKey: string;
}

export function chatMonthlyLimit(plan: string, limits: ChatLimits): number | null {
  if (plan === "INTERNAL") return null;
  if (plan === "PROFESSIONAL") return limits.professionalMonthlyLimit;
  if (plan === "PROFESSIONAL_PLUS") return limits.plusMonthlyLimit;
  return 0;
}

export function chatLimitError(message: string, statusCode = 429): AppError {
  return new AppError(ErrorCodes.USAGE_QUOTA_EXCEEDED, message, { statusCode, report: false });
}

export function chatMetadata(session: ConversationSession, limits: ChatLimits) {
  return {
    expiresAt: session.expiresAt.toISOString(),
    maxMessageCharacters: limits.maxMessageCharacters,
    charactersRemaining: Math.max(0, limits.maxPatientCharacters - session.patientCharacters),
    closureReason: session.closureReason,
  };
}

/** One leased operation across all API processes; no transaction spans an AI call. */
export async function withChatClaim<T>(
  prisma: PrismaClient,
  session: ConversationSession,
  work: (fresh: ConversationSession) => Promise<T>,
): Promise<T> {
  const token = randomUUID();
  const now = new Date();
  const claimed = await prisma.conversationSession.updateMany({
    where: {
      id: session.id,
      tenantId: session.tenantId,
      OR: [{ processingUntil: null }, { processingUntil: { lte: now } }],
    },
    data: { processingToken: token, processingUntil: new Date(now.getTime() + 90_000) },
  });
  if (!claimed.count) throw chatLimitError("A message is still being processed. Please wait.", 409);
  try {
    const fresh = await prisma.conversationSession.findUniqueOrThrow({ where: { id: session.id } });
    if (fresh.expiresAt <= now && !fresh.closedAt) {
      await closeConversation(prisma, fresh.tenantId, fresh.id, "TIME_LIMIT", now);
      return await work(
        await prisma.conversationSession.findUniqueOrThrow({ where: { id: fresh.id } }),
      );
    }
    return await work(fresh);
  } finally {
    await prisma.conversationSession.updateMany({
      where: { id: session.id, tenantId: session.tenantId, processingToken: token },
      data: { processingToken: null, processingUntil: null },
    });
  }
}
