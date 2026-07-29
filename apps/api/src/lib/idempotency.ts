import { createHash } from "node:crypto";
import type { PrismaClient } from "@bam/db";
import { AppError, ConflictError, ErrorCodes, ValidationError } from "@bam/contracts";

/**
 * Idempotency keys. tech-impl §32.
 *
 * ## The failure this exists for
 *
 * A customer on a train taps "Confirm". The booking commits; the response never
 * arrives. They tap again. Without this they now have two appointments, two
 * confirmation emails, and a provider with a double-length gap in their diary
 * that nobody booked.
 *
 * The client sends the same `Idempotency-Key` both times, and the second
 * request replays the first one's response instead of doing the work again.
 *
 * ## Why the request is hashed
 *
 * The key is the client's; the hash is ours. A key reused with a *different*
 * body is a client bug — usually a key generated once per page rather than once
 * per action — and answering it with the first request's response would confirm
 * an appointment nobody asked for. That is refused loudly rather than served
 * quietly.
 *
 * ## Claim first, then work
 *
 * The row is written *before* the operation runs, so a second request arriving
 * mid-flight finds a claim with no response yet and is told the first one is
 * still going. The alternative — write the record afterwards — leaves exactly
 * the window this is meant to close: two concurrent retries both find nothing,
 * both do the work, and the capacity constraint has to catch what the
 * idempotency layer was supposed to.
 *
 * The claim is deliberately *not* part of the operation's transaction. If the
 * work rolls back, the claim stays and its response is never filled in, so the
 * retry gets IDEMPOTENCY_KEY_IN_PROGRESS rather than silently re-running a
 * failed booking. That is the safe direction to be wrong in: a stuck key
 * expires, a duplicated booking does not.
 */

/** How long a key is honoured. Long enough for a retry, short enough to expire. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotentResult<T> {
  value: T;
  /** True when this is the stored response of an earlier identical request. */
  replayed: boolean;
}

export function hashRequest(body: unknown): string {
  // Stable across key order: two structurally identical bodies must hash the
  // same, or a client that serialises its JSON differently on a retry would be
  // told its key was reused.
  return createHash("sha256").update(stableStringify(body)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);

  return `{${entries.join(",")}}`;
}

/**
 * Run `operation` at most once per (tenant, operation, key).
 *
 * `T` must be JSON round-trippable: it is stored and replayed verbatim, so a
 * `Date` would come back a string. Callers pass already-serialised response
 * bodies for exactly that reason.
 */
export async function withIdempotency<T>(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    /** The route, so one client key reused across two operations cannot collide. */
    operation: string;
    key: string;
    requestBody: unknown;
    /** Status recorded alongside the response, replayed with it. */
    successStatus: number;
  },
  operation: () => Promise<T>,
): Promise<IdempotentResult<T>> {
  const requestHash = hashRequest(args.requestBody);
  const where = {
    tenantId_operation_key: {
      tenantId: args.tenantId,
      operation: args.operation,
      key: args.key,
    },
  };

  const existing = await prisma.idempotencyKey.findUnique({ where });

  if (existing) {
    return { value: replay<T>(existing, requestHash), replayed: true };
  }

  try {
    await prisma.idempotencyKey.create({
      data: {
        tenantId: args.tenantId,
        operation: args.operation,
        key: args.key,
        requestHash,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      },
    });
  } catch (error) {
    // Lost the race between the findUnique above and this insert. The other
    // request owns the key; re-read and let it answer.
    if (!isUniqueViolation(error)) throw error;

    const winner = await prisma.idempotencyKey.findUnique({ where });
    if (!winner) throw error;

    return { value: replay<T>(winner, requestHash), replayed: true };
  }

  const value = await operation();

  await prisma.idempotencyKey.update({
    where,
    data: {
      responseStatus: args.successStatus,
      // Cast rather than validate: the caller controls this shape, and it has
      // already passed the route's own response schema.
      responseBody: value as never,
    },
  });

  return { value, replayed: false };
}

function replay<T>(
  row: { requestHash: string; responseBody: unknown; responseStatus: number | null },
  requestHash: string,
): T {
  if (row.requestHash !== requestHash) {
    throw new ConflictError(
      ErrorCodes.IDEMPOTENCY_KEY_REUSED,
      "This idempotency key was already used for a different request. Use a new key for a new action.",
    );
  }

  if (row.responseStatus === null) {
    // Either still running, or it failed and rolled back. Both mean "do not do
    // this again yet" — see the note on claiming first.
    throw new ConflictError(
      ErrorCodes.IDEMPOTENCY_KEY_IN_PROGRESS,
      "An earlier request with this idempotency key is still being processed. Retry shortly.",
    );
  }

  return row.responseBody as T;
}

/**
 * Pull the header, or refuse.
 *
 * Required rather than optional on the routes §32 lists. Making it optional
 * means it is absent exactly when it matters — nobody adds a retry-safety
 * header until after the incident that needed it.
 */
export function requireIdempotencyKey(headers: Record<string, unknown>): string {
  const raw = headers["idempotency-key"];
  const key = typeof raw === "string" ? raw.trim() : "";

  if (key.length === 0) {
    throw new AppError(
      ErrorCodes.IDEMPOTENCY_KEY_REQUIRED,
      "This request requires an Idempotency-Key header.",
      { statusCode: 400 },
    );
  }

  if (key.length > 255) {
    throw new ValidationError("The Idempotency-Key header is too long.", {
      field: "Idempotency-Key",
    });
  }

  return key;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}
