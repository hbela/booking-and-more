"use client";

import { ApiError, apiFetch, idempotencyKey, withIdempotency } from "./api-client";

/**
 * The assistant's half of the public API.
 * docs/phase-7-chat-booking.md · docs/phase-8-push-to-talk-voice.md.
 *
 * Kept beside `api-client.ts` rather than inside it because of the one thing it
 * does that nothing else in the app does: it carries a credential. The session
 * token is minted once, held in memory for the life of the panel, and put in
 * `X-Conversation-Token` on every subsequent call.
 *
 * It is deliberately **not** persisted. A token in `localStorage` is a token
 * that outlives the tab it was issued to and survives in a shared browser; the
 * conversation itself is thirty minutes long and the form is always there, so
 * losing it on refresh costs a customer one greeting.
 */

export type UiHint =
  | "NONE"
  | "SERVICE_LIST"
  | "PROVIDER_LIST"
  | "SLOT_LIST"
  | "CUSTOMER_FORM"
  | "CONFIRMATION_CARD"
  | "BOOKING_SUMMARY";

export interface AssistantMessage {
  /** A key under the `conversation` namespace — never a sentence (tech-impl §20). */
  key: string;
  params?: Record<string, string | number>;
  ui: UiHint;
}

export interface ConversationService {
  id: string;
  name: string;
  durationMinutes: number;
  priceMinor: number | null;
  currency: string | null;
}

export interface ConversationProvider {
  id: string;
  displayName: string;
}

export interface ConversationSlot {
  providerId: string;
  providerName: string;
  startAt: string;
  endAt: string;
}

export interface ConfirmationCard {
  actionId: string;
  tool: "confirmBooking" | "confirmReschedule" | "confirmCancellation";
  serviceName: string;
  providerName: string;
  locationName: string | null;
  startAt: string;
  endAt: string;
  priceMinor: number | null;
  currency: string | null;
  customerName: string | null;
  expiresAt: string;
}

export interface ConversationTurn {
  conversationId: string;
  state: string;
  status: "ACTIVE" | "COMPLETED" | "CANCELLED" | "EXPIRED";
  message: AssistantMessage;
  services?: ConversationService[];
  providers?: ConversationProvider[];
  slots?: ConversationSlot[];
  confirmation: ConfirmationCard | null;
  bookingReference: string | null;
  turnsRemaining: number;
}

export interface StartedConversation extends ConversationTurn {
  sessionToken: string;
  expiresAt: string;
}
export interface PublicAssistant {
  available: boolean;
  personaName: string;
  greeting: string;
  supportedLocales: string[];
  branding: { businessName: string; logoUrl: string | null };
}
export interface ReplayedConversation extends ConversationTurn {
  messages: Array<{
    id: string;
    sender: "CUSTOMER" | "ASSISTANT" | "SYSTEM";
    content: string;
    spoken: boolean;
    createdAt: string;
  }>;
  expiresAt: string;
}

/** The credential, and the id it opens. */
export interface ConversationSession {
  id: string;
  token: string;
}

function auth(session: ConversationSession): Record<string, string> {
  return { "X-Conversation-Token": session.token };
}

export async function startConversation(args: {
  tenantSlug: string;
  locale: string;
  timezone: string;
  managementToken?: string | undefined;
}): Promise<StartedConversation> {
  return apiFetch<StartedConversation>(`/v1/public/tenants/${args.tenantSlug}/conversations`, {
    method: "POST",
    body: {
      channel: "CHAT",
      locale: args.locale,
      timezone: args.timezone,
      ...(args.managementToken === undefined ? {} : { managementToken: args.managementToken }),
    },
  });
}

export async function sendMessage(args: {
  session: ConversationSession;
  text: string;
  onTextDelta?: ((message: AssistantMessage) => void) | undefined;
}): Promise<ConversationTurn> {
  const base = process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "http://localhost:3001";
  const response = await fetch(`${base}/v1/public/conversations/${args.session.id}/messages`, {
    method: "POST",
    credentials: "include",
    headers: {
      ...auth(args.session),
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ text: args.text }),
  });
  if (!response.ok) {
    const text = await response.text();
    const envelope = JSON.parse(text) as {
      error?: { message?: string; code?: string; requestId?: string };
    };
    throw new ApiError(
      envelope.error?.message ?? "Request failed.",
      envelope.error?.code ?? "UNKNOWN",
      response.status,
      envelope.error?.requestId,
    );
  }
  let completed: ConversationTurn | undefined;
  const reader = response.body?.getReader();
  if (!reader)
    throw new ApiError("The assistant stream could not be read.", "PROVIDER_UNAVAILABLE", 502);
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/u);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const lines = block.split(/\r?\n/u);
      const event = lines[0]?.slice("event: ".length);
      const data = lines.find((line) => line.startsWith("data: "));
      if (!data) continue;
      if (event === "text_delta")
        args.onTextDelta?.((JSON.parse(data.slice(6)) as { text: AssistantMessage }).text);
      if (event === "completion") completed = JSON.parse(data.slice(6)) as ConversationTurn;
    }
    if (done) break;
  }
  if (!completed)
    throw new ApiError("The assistant stream ended early.", "PROVIDER_UNAVAILABLE", 502);
  return completed;
}

export function assistantAvailability(tenantSlug: string): Promise<PublicAssistant> {
  return apiFetch(`/v1/public/tenants/${encodeURIComponent(tenantSlug)}/assistant`);
}

export function replayConversation(session: ConversationSession): Promise<ReplayedConversation> {
  return apiFetch(`/v1/public/conversations/${session.id}`, { headers: auth(session) });
}

export async function confirmAction(args: {
  session: ConversationSession;
  actionId: string;
}): Promise<ConversationTurn> {
  return apiFetch<ConversationTurn>(
    `/v1/public/conversations/${args.session.id}/actions/${args.actionId}/confirm`,
    {
      method: "POST",
      // Rule 16: a write a customer can retry carries a key. Pressing Confirm
      // twice on a slow connection must not make two bookings — and the pending
      // action refuses the second attempt anyway, which is the belt to this
      // brace.
      headers: { ...auth(args.session), ...withIdempotency(idempotencyKey()) },
    },
  );
}

export async function cancelAction(args: {
  session: ConversationSession;
  actionId: string;
}): Promise<ConversationTurn> {
  return apiFetch<ConversationTurn>(
    `/v1/public/conversations/${args.session.id}/actions/${args.actionId}/cancel`,
    { method: "POST", headers: auth(args.session) },
  );
}

/**
 * Upload one recording and get the transcript back.
 *
 * Hand-rolled rather than routed through `apiFetch`, because the body is
 * `FormData` and `apiFetch` sets a JSON content type. `durationMs` travels as a
 * field: the browser is the only party that knows how long the customer held
 * the button, and the server treats the figure as a claim
 * (see `audio.ts`'s `validateAudio`).
 */
/**
 * Error codes the panel treats as "fold away and let the form take over".
 *
 * PRD §12.4 requires a form fallback for every voice action, and these are the
 * four ways the assistant becomes unavailable: no provider configured, the
 * tenant's allowance spent, the conversation timed out, or too many turns. None
 * of them is a reason to strand somebody who came here to book.
 */
export const ASSISTANT_UNAVAILABLE_CODES = new Set([
  "CONVERSATION_UNAVAILABLE",
  "USAGE_QUOTA_EXCEEDED",
  "CONVERSATION_NOT_FOUND",
  "CONVERSATION_TURN_LIMIT_REACHED",
]);

export function isAssistantUnavailable(error: unknown): boolean {
  return error instanceof ApiError && ASSISTANT_UNAVAILABLE_CODES.has(error.code);
}
