import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { REDACT_PATHS, REDACTED } from "./redaction.js";

/**
 * These assert CLAUDE.md rule 6 — secrets must not reach the logs. They build a
 * logger over the same redact config `createLogger` uses, writing to an
 * in-memory stream so the emitted JSON can be inspected directly.
 */
function captureLogs() {
  const lines: Record<string, unknown>[] = [];

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      callback();
    },
  });

  const logger = pino(
    {
      level: "info",
      base: { service: "test" },
      redact: { paths: [...REDACT_PATHS], censor: REDACTED, remove: false },
    },
    stream,
  );

  return { logger, lines };
}

describe("log redaction", () => {
  it("redacts the Authorization and Cookie request headers", () => {
    const { logger, lines } = captureLogs();

    logger.info({
      req: { headers: { authorization: "Bearer sk-live-abc123", cookie: "session=secret" } },
    });

    const req = lines[0]?.["req"] as { headers: Record<string, string> };
    expect(req.headers["authorization"]).toBe(REDACTED);
    expect(req.headers["cookie"]).toBe(REDACTED);
  });

  it("redacts connection strings — the failure that motivated this list", () => {
    const { logger, lines } = captureLogs();

    logger.info({ DATABASE_URL: "postgresql://postgres:hunter2@localhost:5432/bam" });

    expect(lines[0]?.["DATABASE_URL"]).toBe(REDACTED);
    expect(JSON.stringify(lines[0])).not.toContain("hunter2");
  });

  it("redacts OAuth tokens at any nesting level", () => {
    const { logger, lines } = captureLogs();

    logger.info({
      integration: { encryptedRefreshToken: "1//0eXampleRefresh", accessToken: "ya29.a0Ae" },
    });

    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain("0eXampleRefresh");
    expect(serialized).not.toContain("ya29.a0Ae");
  });

  it("redacts customer PII carried on booking payloads", () => {
    const { logger, lines } = captureLogs();

    logger.info({
      booking: {
        id: "booking_1",
        customerEmail: "anna@example.com",
        customerPhone: "+36301234567",
        customerName: "Anna Kovács",
      },
    });

    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain("anna@example.com");
    expect(serialized).not.toContain("+36301234567");
    expect(serialized).not.toContain("Anna Kovács");
    // Non-sensitive fields survive, otherwise the log is useless.
    expect(serialized).toContain("booking_1");
  });

  it("leaves ordinary fields untouched", () => {
    const { logger, lines } = captureLogs();

    logger.info({ tenantId: "tenant_1", requestId: "req_1", module: "booking" });

    expect(lines[0]?.["tenantId"]).toBe("tenant_1");
    expect(lines[0]?.["requestId"]).toBe("req_1");
    expect(lines[0]?.["module"]).toBe("booking");
  });
});
