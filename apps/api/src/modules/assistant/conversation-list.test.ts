import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@bam/db";
import { AssistantService } from "./assistant.service.js";
import { conversationListQuerySchema } from "./assistant.schemas.js";

describe("conversation list date filtering", () => {
  it("filters the selected tenant and day before pagination", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new AssistantService({
      conversationSession: { findMany },
    } as unknown as PrismaClient);
    const query = conversationListQuerySchema.parse({
      from: "2026-09-14T22:00:00.000Z",
      to: "2026-09-15T22:00:00.000Z",
      limit: "25",
      offset: "25",
    });
    await service.listConversations("tenant-1", query);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        lastActivityAt: {
          gte: new Date(query.from!),
          lt: new Date(query.to!),
        },
      },
      orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
      take: 25,
      skip: 25,
    });
  });

  it("rejects malformed dates", () => {
    expect(conversationListQuerySchema.safeParse({ from: "yesterday" }).success).toBe(false);
    expect(conversationListQuerySchema.safeParse({ to: "2026-02-30T00:00:00Z" }).success).toBe(
      false,
    );
  });
});
