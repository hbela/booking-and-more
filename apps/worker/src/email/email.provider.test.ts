import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@bam/observability";

import { createLoggingProvider, createResendProvider } from "./email.provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("logging email provider", () => {
  it("never writes recipients, bodies, or bearer links to logs", async () => {
    const info = vi.fn();
    const logger = { info } as unknown as Logger;
    const provider = createLoggingProvider(logger);

    await provider.send({
      to: "private.person@example.test",
      subject: "Your invitation",
      text: "Accept at https://app.test/invitations/live-secret-token",
      html: '<a href="https://app.test/invitations/live-secret-token">Accept</a>',
      idempotencyKey: "notification/test",
    });

    const serialized = JSON.stringify(info.mock.calls);
    expect(serialized).not.toContain("private.person");
    expect(serialized).not.toContain("live-secret-token");
    expect(serialized).not.toContain("invitations/");
    expect(serialized).toContain("example.test");
  });

  it("passes the notification identity to Resend's idempotency header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "email_123" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = createResendProvider({
      apiKey: "re_test",
      from: "Bookings <send@example.test>",
      logger: { info: vi.fn() } as unknown as Logger,
    });

    await provider.send({
      to: "person@example.test",
      subject: "Confirmation",
      text: "Confirmed",
      html: "<p>Confirmed</p>",
      idempotencyKey: "notification/cuid123",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        headers: expect.objectContaining({ "Idempotency-Key": "notification/cuid123" }),
      }),
    );
  });
});
