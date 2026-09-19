import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@bam/db";
import { PublicCatalogueService } from "./catalogue.service.js";

describe("public patient QR entitlements", () => {
  it.each([
    ["STARTER", "ACTIVE", false],
    ["PROFESSIONAL", "ACTIVE", true],
    ["PROFESSIONAL", "TRIALING", true],
    ["PROFESSIONAL", "CANCELED", false],
    ["INTERNAL", "ACTIVE", true],
    [undefined, undefined, false],
  ])("%s / %s exposes chat: %s", async (plan, status, assistant) => {
    const findUnique = vi.fn().mockResolvedValue(plan ? { plan, status } : null);
    const service = new PublicCatalogueService({
      subscription: { findUnique },
    } as unknown as PrismaClient);
    expect(await service.appFeatures("tenant-1")).toEqual({ assistant });
    expect(findUnique).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1" },
      select: { plan: true, status: true },
    });
  });
});
