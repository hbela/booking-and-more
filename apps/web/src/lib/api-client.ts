"use client";

import type { ErrorEnvelope } from "@bam/contracts";

const API_BASE_URL = process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "http://localhost:3001";

/**
 * Typed error carrying the API's machine-readable code and request ID.
 *
 * The request ID is the useful part: a user can quote it in a bug report and it
 * ties their failure to exactly one line in the server logs.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  /**
   * Sent as X-Tenant-Id. The API validates it against membership regardless.
   *
   * Explicitly `| undefined` so callers can pass a value that is still being
   * resolved without a cast (exactOptionalPropertyTypes is on).
   */
  tenantId?: string | undefined;
}

/**
 * Thin wrapper over fetch that understands the API's error envelope.
 *
 * Deliberately small — the pattern is lifted from booking-for-all's
 * `apiFetch.ts`, which was one of the genuinely good pieces of that codebase.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, tenantId, headers, ...rest } = options;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    // Cross-origin: without this the session cookie never travels.
    credentials: "include",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(tenantId === undefined ? {} : { "X-Tenant-Id": tenantId }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const envelope = payload as ErrorEnvelope | null;
    throw new ApiError(
      envelope?.error?.message ?? "Request failed.",
      envelope?.error?.code ?? "UNKNOWN",
      response.status,
      envelope?.error?.requestId,
    );
  }

  return payload as T;
}

// --- Shapes the dashboard needs -------------------------------------------
// Hand-written for now. Epic 2 generates these from the OpenAPI document so
// they cannot drift from the server.

export interface MeResponse {
  user: { id: string; name: string; email: string; isPlatformAdmin: boolean };
  tenant: {
    id: string;
    slug: string;
    name: string;
    status: "TRIAL" | "ACTIVE" | "SUSPENDED" | "CLOSED";
    defaultTimezone: string;
    defaultLanguage: string;
  } | null;
  membership: { id: string; role: string; providerId: string | null } | null;
  permissions: string[];
}

export interface TenantSummary {
  id: string;
  slug: string;
  name: string;
  status: string;
  role: string;
}

export interface Member {
  id: string;
  role: string;
  status: string;
  joinedAt: string | null;
  user: { id: string; name: string; email: string };
}

export interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  invitedBy: { name: string; email: string };
}
