import { readFile } from "node:fs/promises";
import { URL as NodeURL } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { deliver, evaluate, type Env } from "./index";

const now = 1790200000;
const token = "a".repeat(40);
let mf: Miniflare;
let env: Env;
const pending: Promise<unknown>[] = [];
const context = {
  waitUntil(p: Promise<unknown>) {
    pending.push(p);
  },
} as ExecutionContext;
const rows = (table: string) =>
  env.DB.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>();
const event = (
  status: "started" | "succeeded" | "failed",
  startedAt = now,
  runId = crypto.randomUUID(),
) => ({
  runId,
  status,
  startedAt,
  ...(status === "failed" ? { stage: "dump_upload" as const } : {}),
});

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    d1Databases: ["DB"],
    compatibilityDate: "2026-07-30",
  });
  const db = await mf.getD1Database("DB");
  env = {
    DB: db,
    MONITOR_IDS: "bam-staging",
    MONITOR_TOKENS: JSON.stringify({ "bam-staging": token }),
    RESEND_API_KEY: "test-only",
    ALERT_FROM: "monitor@example.com",
    ALERT_TO: "operator@example.com",
  };
  const sql = await readFile(
    new NodeURL("../migrations/0001_monitor.sql", import.meta.url),
    "utf8",
  );
  for (const statement of sql.split(";").filter((s) => s.trim()))
    await env.DB.prepare(statement).run();
});
beforeEach(async () => {
  await env.DB.batch(
    ["notifications", "incidents", "runs", "monitors"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
});
afterEach(async () => {
  await Promise.all(pending.splice(0));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await mf.dispose();
});

function request(body: unknown, auth = token, monitor = "bam-staging") {
  return worker.fetch(
    new Request(`https://monitor.example/v1/check-ins/${monitor}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    }),
    env,
    context,
  );
}

describe("authenticated check-ins", () => {
  it("rejects unknown monitors and bad tokens without writing state", async () => {
    expect((await request(event("started"), token, "bam-production")).status).toBe(404);
    expect((await request(event("started"), "wrong")).status).toBe(401);
    expect((await rows("monitors")).results).toHaveLength(0);
  });
  it("bounds payloads and validates timestamps/stages", async () => {
    expect((await request({ padding: "x".repeat(2000) })).status).toBe(413);
    expect((await request(event("started", now + 61))).status).toBe(400);
    expect((await request(event("succeeded", now - 3601))).status).toBe(400);
    expect((await request({ ...event("failed"), stage: "customer details" })).status).toBe(400);
    expect((await request({ ...event("succeeded"), email: "patient@example.com" })).status).toBe(
      400,
    );
  });
  it("accepts success and uses run start rather than receipt time", async () => {
    expect((await request(event("succeeded", now - 300))).status).toBe(204);
    expect((await rows("monitors")).results[0]?.last_success).toBe(now - 300);
  });
  it("rejects configuration that shares one token between monitors", async () => {
    const shared = {
      ...env,
      MONITOR_IDS: "bam-staging,bam-test",
      MONITOR_TOKENS: JSON.stringify({ "bam-staging": token, "bam-test": token }),
    };
    const req = new Request("https://monitor.example/v1/check-ins/bam-staging", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(event("started")),
    });
    expect((await worker.fetch(req, shared, context)).status).toBe(503);
    expect((await rows("monitors")).results).toHaveLength(0);
  });
  it("isolates registered monitor tokens and incidents", async () => {
    const other = {
      ...env,
      MONITOR_IDS: "bam-staging,bam-test",
      MONITOR_TOKENS: JSON.stringify({ "bam-staging": token, "bam-test": "b".repeat(40) }),
    };
    const req = new Request("https://monitor.example/v1/check-ins/bam-test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(event("failed")),
    });
    expect((await worker.fetch(req, other, context)).status).toBe(401);
    await evaluate(other, now, "bam-test", event("failed"));
    expect((await rows("incidents")).results.map((i) => i.monitor)).toEqual(["bam-test"]);
  });
});

describe("incident state and durable outbox", () => {
  it("arms before the first success and alerts at fifty minutes", async () => {
    await evaluate(env, now);
    await evaluate(env, now + 2999);
    expect((await rows("incidents")).results).toHaveLength(0);
    await evaluate(env, now + 3000);
    expect((await rows("incidents")).results[0]?.reason).toBe("stale");
  });
  it("detects an overrun at twenty minutes and recovers on timely success", async () => {
    const run = event("started");
    await evaluate(env, now, "bam-staging", run);
    await evaluate(env, now + 1200);
    expect((await rows("incidents")).results[0]?.reason).toBe("overrun");
    await evaluate(env, now + 1300, "bam-staging", { ...run, status: "succeeded" });
    expect((await rows("incidents")).results[0]?.closed_at).toBe(now + 1300);
    expect((await rows("notifications")).results).toHaveLength(2);
  });
  it("failure alerts immediately, with one reminder per six-hour interval", async () => {
    await evaluate(env, now, "bam-staging", event("failed"));
    expect((await rows("notifications")).results).toHaveLength(1);
    await evaluate(env, now + 21599);
    expect((await rows("notifications")).results).toHaveLength(1);
    await Promise.all([evaluate(env, now + 21600), evaluate(env, now + 21600)]);
    expect((await rows("notifications")).results).toHaveLength(2);
  });
  it("duplicates and late start/conflicting terminal reports cannot change success", async () => {
    const run = event("succeeded");
    await evaluate(env, now, "bam-staging", run);
    await evaluate(env, now + 100, "bam-staging", run);
    await evaluate(env, now + 200, "bam-staging", { ...run, status: "started" });
    await evaluate(env, now + 300, "bam-staging", { ...run, status: "failed", stage: "retention" });
    expect((await rows("runs")).results[0]?.status).toBe("succeeded");
    expect((await rows("monitors")).results[0]?.last_success).toBe(now);
    expect((await rows("incidents")).results).toHaveLength(0);
  });
  it("older failures cannot undo a newer successful run", async () => {
    await evaluate(env, now, "bam-staging", event("succeeded"));
    await evaluate(env, now + 10, "bam-staging", event("failed", now - 100));
    expect((await rows("incidents")).results).toHaveLength(0);
  });
  it("a conflicting start timestamp cannot finish an existing run", async () => {
    const run = event("started");
    await evaluate(env, now, "bam-staging", run);
    await evaluate(env, now + 10, "bam-staging", {
      ...run,
      status: "succeeded",
      startedAt: now + 10,
    });
    expect((await rows("runs")).results[0]?.status).toBe("started");
    expect((await rows("monitors")).results[0]?.last_success).toBeNull();
  });
  it("retention does not regenerate an initial email for a month-old open incident", async () => {
    await evaluate(env, now, "bam-staging", event("failed"));
    await evaluate(env, now + 2592300);
    await evaluate(env, now + 2592600);
    const notices = (await rows("notifications")).results;
    expect(notices).toHaveLength(1);
    expect(String(notices[0]?.id)).toContain(":reminder:");
  });
  it("an old success cannot clear a stale-backup incident", async () => {
    await evaluate(env, now);
    await evaluate(env, now + 3500, "bam-staging", event("succeeded"));
    expect((await rows("incidents")).results[0]?.closed_at).toBeNull();
  });
  it("concurrent failures create one incident and initial email", async () => {
    const run = event("failed");
    await Promise.all([
      evaluate(env, now, "bam-staging", run),
      evaluate(env, now, "bam-staging", run),
    ]);
    expect((await rows("incidents")).results).toHaveLength(1);
    expect((await rows("notifications")).results).toHaveLength(1);
  });
  it("retries delivery with the same key and immutable payload; concurrent dispatch is leased", async () => {
    await evaluate(env, now, "bam-staging", event("failed"));
    const send = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    await deliver(env, now, send);
    expect((await rows("notifications")).results[0]?.sent_at).toBeNull();
    await Promise.all([deliver(env, now + 300, send), deliver(env, now + 300, send)]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[1].body).toBe(send.mock.calls[1]?.[1].body);
    expect(send.mock.calls[0]?.[1].headers["Idempotency-Key"]).toBe(
      send.mock.calls[1]?.[1].headers["Idempotency-Key"],
    );
    expect((await rows("notifications")).results[0]?.sent_at).toBe(now + 300);
  });
  it("does not risk duplicate delivery beyond the provider idempotency window", async () => {
    await evaluate(env, now, "bam-staging", event("failed"));
    const send = vi.fn().mockRejectedValue(new Error("network"));
    await deliver(env, now, send);
    await deliver(env, now + 82801, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await rows("notifications")).results[0]?.blocked).toBe(1);
  });
  it("cleans old diagnostic rows while retaining latest successful backup age", async () => {
    await evaluate(env, now, "bam-staging", event("failed"));
    await evaluate(env, now + 10, "bam-staging", event("succeeded", now + 10));
    await evaluate(env, now + 2592011);
    expect((await rows("runs")).results).toHaveLength(0);
    expect((await rows("monitors")).results[0]?.last_success).toBe(now + 10);
    expect((await rows("incidents")).results).toHaveLength(1); // current stale incident only
  });
});
