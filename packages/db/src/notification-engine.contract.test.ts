import { describe, expect, it } from "vitest";
import {
  NotificationChannels,
  NotificationTypes,
  SUPPORTED_LOCALES,
} from "@bam/notification-engine";

import { NotificationChannel, NotificationStatus, NotificationType } from "./index.js";

/**
 * The seam between the pure engine and the schema.
 *
 * @bam/notification-engine has no runtime dependencies (CLAUDE.md rule 8), so
 * it restates the notification enums as string literals rather than importing
 * them from Prisma. That is the right trade — it keeps the engine testable
 * without a database — but it creates exactly one way to be wrong: someone adds
 * a value on one side and not the other, and the mismatch surfaces at runtime
 * as a row the engine planned and PostgreSQL refuses.
 *
 * These assertions make that a failing test instead. No database needed: both
 * sides are compile-time constants.
 */

describe("notification enums", () => {
  it("declares the same types in the engine and the schema", () => {
    expect(Object.values(NotificationTypes).sort()).toEqual(
      Object.values(NotificationType).sort(),
    );
  });

  it("declares the same channels in the engine and the schema", () => {
    expect(Object.values(NotificationChannels).sort()).toEqual(
      Object.values(NotificationChannel).sort(),
    );
  });

  it("has a template for every type the schema can store", () => {
    // Every enum value must be plannable; a type the engine cannot produce is
    // dead weight in the schema, and one it produces that the schema rejects
    // is a failed insert.
    for (const type of Object.values(NotificationType)) {
      expect(Object.values(NotificationTypes)).toContain(type);
    }
  });

  it("keeps SKIPPED distinct from FAILED", () => {
    // A booking with no email address has nothing to send to, which is a
    // correct outcome. Collapsing it into FAILED would fill the dead-letter
    // queue with bookings that are perfectly fine.
    expect(Object.values(NotificationStatus)).toContain("SKIPPED");
    expect(Object.values(NotificationStatus)).toContain("FAILED");
  });

  it("supports the languages the product ships in", () => {
    // PRD §12.5 — Hungarian and English at launch.
    expect([...SUPPORTED_LOCALES]).toEqual(["hu", "en"]);
  });
});
