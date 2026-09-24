import { z } from "zod";

export interface Env {
  DB: D1Database;
  MONITOR_IDS: string;
  MONITOR_TOKENS: string;
  RESEND_API_KEY: string;
  ALERT_FROM: string;
  ALERT_TO: string;
}

const eventSchema = z
  .object({
    runId: z.string().uuid(),
    status: z.enum(["started", "succeeded", "failed"]),
    startedAt: z.number().int().nonnegative(),
    stage: z
      .enum(["configuration", "lock", "database", "dump_upload", "promotion", "retention"])
      .optional(),
  })
  .strict()
  .refine((e) => (e.status === "failed" ? !!e.stage : !e.stage));
type CheckIn = z.infer<typeof eventSchema>;
const configSchema = z.object({
  MONITOR_IDS: z.string().regex(/^bam-[a-z0-9-]+(?:,bam-[a-z0-9-]+)*$/),
  MONITOR_TOKENS: z
    .string()
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid token configuration" });
        return z.NEVER;
      }
    })
    .pipe(z.record(z.string(), z.string().min(32))),
  RESEND_API_KEY: z.string().min(1),
  ALERT_FROM: z.email(),
  ALERT_TO: z.email(),
});

function config(env: Env) {
  const c = configSchema.parse(env);
  const ids = c.MONITOR_IDS.split(",");
  if (ids.some((id) => !c.MONITOR_TOKENS[id])) throw new Error("Missing monitor token");
  if (new Set(ids.map((id) => c.MONITOR_TOKENS[id])).size !== ids.length)
    throw new Error("Monitor tokens must be distinct");
  return { ...c, ids };
}

// Hash both operands before comparing so token length/content does not control comparison work.
async function authenticated(header: string | null, token: string): Promise<boolean> {
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [actual, expected] = await Promise.all([digest(header ?? ""), digest(`Bearer ${token}`)]);
  return actual.reduce((difference, byte, i) => difference | (byte ^ expected[i]!), 0) === 0;
}

/** One D1 batch is one transaction: event, incident transitions and outbox move together. */
export async function evaluate(
  env: Env,
  now: number,
  monitor?: string,
  event?: CheckIn,
): Promise<void> {
  const c = config(env);
  const stmt = (sql: string, ...values: (string | number | null)[]) =>
    env.DB.prepare(sql).bind(...values);
  const statements = c.ids.map((id) =>
    stmt("INSERT OR IGNORE INTO monitors(id,armed_at) VALUES (?,?)", id, now),
  );
  if (monitor && event) {
    statements.push(
      stmt(
        `INSERT INTO runs(monitor,id,started_at,status,stage,received_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(monitor,id) DO UPDATE SET status=excluded.status,stage=excluded.stage,received_at=excluded.received_at
      WHERE runs.status='started' AND excluded.status!='started' AND runs.started_at=excluded.started_at`,
        monitor,
        event.runId,
        event.startedAt,
        event.status,
        event.stage ?? null,
        now,
      ),
    );
    statements.push(
      stmt(
        `UPDATE monitors SET last_success=(SELECT MAX(started_at) FROM runs WHERE monitor=? AND status='succeeded')
      WHERE id=? AND EXISTS(SELECT 1 FROM runs WHERE monitor=? AND status='succeeded' AND started_at>COALESCE(monitors.last_success,0))`,
        monitor,
        monitor,
        monitor,
      ),
    );
  }
  for (const id of c.ids) {
    statements.push(
      stmt(
        `UPDATE monitors SET reason=CASE
      WHEN EXISTS(SELECT 1 FROM runs WHERE monitor=monitors.id AND status='failed' AND started_at>COALESCE(last_success,0)) THEN 'failed'
      WHEN EXISTS(SELECT 1 FROM runs WHERE monitor=monitors.id AND status='started' AND started_at>COALESCE(last_success,0) AND started_at<=?) THEN 'overrun'
      WHEN COALESCE(last_success,armed_at)<=? THEN 'stale' ELSE NULL END,
      stage=(SELECT stage FROM runs WHERE monitor=monitors.id AND status='failed' AND started_at>COALESCE(last_success,0) ORDER BY started_at DESC LIMIT 1)
      WHERE id=?`,
        now - 1200,
        now - 3000,
        id,
      ),
    );
    statements.push(
      stmt(
        `UPDATE incidents SET closed_at=? WHERE monitor=? AND closed_at IS NULL
      AND EXISTS(SELECT 1 FROM monitors WHERE id=? AND reason IS NULL AND last_success IS NOT NULL)`,
        now,
        id,
        id,
      ),
    );
    statements.push(
      stmt(
        `INSERT OR IGNORE INTO incidents(id,monitor,opened_at,reason,stage)
      SELECT ?,id,?,reason,stage FROM monitors WHERE id=? AND reason IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM incidents WHERE monitor=? AND closed_at IS NULL)`,
        crypto.randomUUID(),
        now,
        id,
        id,
      ),
    );
    // Immutable email payloads and IDs make overlapping requests / scheduled checks safe.
    for (const kind of ["incident", "recovery", "reminder"] as const) {
      const suffix =
        kind === "reminder" ? `|| ':' || CAST((? - i.opened_at)/21600 AS INTEGER)` : "";
      const condition =
        kind === "recovery"
          ? "i.closed_at=?"
          : kind === "reminder"
            ? "i.closed_at IS NULL AND ? >= i.opened_at+21600"
            : "i.opened_at=?";
      const args: (string | number)[] = [];
      if (kind === "reminder") args.push(now);
      args.push(now, kind, c.ALERT_FROM, c.ALERT_TO, now, now, id);
      args.push(now);
      statements.push(
        stmt(
          `INSERT OR IGNORE INTO notifications(id,incident,created_at,payload)
        SELECT i.id || ':${kind}' ${suffix},i.id,?,json_object('kind',?,'from',?,'to',?,
        'monitor',i.monitor,'reason',i.reason,'stage',i.stage,'openedAt',i.opened_at,'closedAt',i.closed_at,
        'checkedAt',?,'lastSuccess',m.last_success,'backupAgeSeconds',?-COALESCE(m.last_success,m.armed_at))
        FROM incidents i JOIN monitors m ON m.id=i.monitor WHERE i.monitor=? AND ${condition}`,
          ...args,
        ),
      );
    }
  }
  statements.push(
    stmt("DELETE FROM runs WHERE received_at<? AND status!='started'", now - 2592000),
  );
  statements.push(stmt("DELETE FROM runs WHERE started_at<? AND status='started'", now - 2592000));
  statements.push(stmt("DELETE FROM notifications WHERE created_at<?", now - 2592000));
  statements.push(
    stmt(
      "DELETE FROM notifications WHERE incident IN (SELECT id FROM incidents WHERE closed_at<?) AND sent_at IS NOT NULL",
      now - 2592000,
    ),
  );
  statements.push(
    stmt(
      "DELETE FROM incidents WHERE closed_at<? AND NOT EXISTS(SELECT 1 FROM notifications WHERE incident=incidents.id)",
      now - 2592000,
    ),
  );
  await env.DB.batch(statements);
}

interface Notice {
  id: string;
  payload: string;
  first_attempt: number;
}
export async function deliver(env: Env, now: number, send: typeof fetch = fetch): Promise<void> {
  // Never resend an ambiguous delivery beyond Resend's 24-hour deduplication window.
  const blocked = await env.DB.prepare(
    `UPDATE notifications SET blocked=1 WHERE sent_at IS NULL AND blocked=0 AND first_attempt<?`,
  )
    .bind(now - 82800)
    .run();
  if (blocked.meta.changes)
    console.error("Backup alert delivery needs reconciliation; retry window exceeded");
  const claimed = await env.DB.prepare(
    `UPDATE notifications SET lease_until=?,first_attempt=COALESCE(first_attempt,?)
    WHERE id IN (SELECT id FROM notifications WHERE sent_at IS NULL AND blocked=0 AND lease_until<=? ORDER BY created_at,id LIMIT 2)
    RETURNING id,payload,first_attempt`,
  )
    .bind(now + 60, now, now)
    .all<Notice>();
  for (const notice of claimed.results) {
    try {
      const payload = JSON.parse(notice.payload) as Record<string, unknown>;
      const response = await send("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": notice.id,
        },
        body: JSON.stringify({
          from: payload.from,
          to: [payload.to],
          subject: `Backup ${String(payload.kind)}: ${String(payload.monitor)}`,
          text: JSON.stringify(payload, null, 2),
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Email rejected");
      await env.DB.prepare("UPDATE notifications SET sent_at=? WHERE id=? AND sent_at IS NULL")
        .bind(now, notice.id)
        .run();
    } catch {
      console.error("Backup alert delivery failed; retry pending");
    }
  }
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    try {
      const c = config(env);
      const match = /^\/v1\/check-ins\/(bam-[a-z0-9-]+)$/.exec(new URL(request.url).pathname);
      const id = match?.[1];
      if (request.method !== "POST" || !id || !c.ids.includes(id))
        return new Response(null, { status: 404 });
      if (!(await authenticated(request.headers.get("Authorization"), c.MONITOR_TOKENS[id]!)))
        return new Response(null, { status: 401 });
      // Bound streamed bodies too; Content-Length is not trusted.
      const reader = request.body?.getReader();
      if (!reader) return new Response(null, { status: 400 });
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const value: unknown = part.value;
        if (!(value instanceof Uint8Array)) return new Response(null, { status: 400 });
        size += value.byteLength;
        if (size > 1024) {
          await reader.cancel();
          return new Response(null, { status: 413 });
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const parsed = eventSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
      const now = Math.floor(Date.now() / 1000);
      if (!parsed.success || parsed.data.startedAt > now + 60 || parsed.data.startedAt < now - 3600)
        return new Response(null, { status: 400 });
      await evaluate(env, now, id, parsed.data);
      context.waitUntil(
        deliver(env, now).catch(() => {
          console.error("Backup alert dispatch failed; retry pending");
        }),
      );
      return new Response(null, { status: 204 });
    } catch (error) {
      if (error instanceof SyntaxError) return new Response(null, { status: 400 });
      console.error("Backup monitor request failed");
      return new Response(null, { status: 503 });
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await evaluate(env, now);
    await deliver(env, now);
  },
};
