import type { PrismaClient } from "./generated/prisma/client.js";

/** Exactly one closure message, including when a worker races a request. */
export async function closeConversation(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
  reason: string,
  now = new Date(),
): Promise<{ closed: number; holdsReleased: number }> {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.conversationSession.updateMany({
      where: { id, tenantId, closedAt: null },
      data: { closedAt: now, closureReason: reason, status: "EXPIRED", machineState: "EXPIRED" },
    });
    if (!changed.count) return { closed: 0, holdsReleased: 0 };
    let holdsReleased = 0;
    await tx.conversationMessage.create({
      data: {
        tenantId,
        sessionId: id,
        sender: "ASSISTANT",
        messageType: "STRUCTURED",
        content: "conversation.goodbye",
      },
    });
    await tx.conversationPendingAction.updateMany({
      where: { tenantId, sessionId: id, status: "PENDING" },
      data: { status: "EXPIRED" },
    });
    const session = await tx.conversationSession.findUniqueOrThrow({ where: { id } });
    const holds = await tx.bookingHold.findMany({
      where: {
        tenantId,
        status: "ACTIVE",
        OR: [{ sessionId: id }, ...(session.holdId ? [{ id: session.holdId }] : [])],
      },
      select: { id: true },
    });
    for (const hold of holds) {
      const released = await tx.bookingHold.updateMany({
        where: { id: hold.id, tenantId, status: "ACTIVE" },
        data: { status: "RELEASED" },
      });
      holdsReleased += released.count;
      if (released.count)
        await tx.capacityReservation.updateMany({
          where: { tenantId, holdId: hold.id, status: "ACTIVE" },
          data: { status: "RELEASED" },
        });
    }
    return { closed: 1, holdsReleased };
  });
}
