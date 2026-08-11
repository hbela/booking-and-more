"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Send, Sparkles } from "lucide-react";
import { ApiError, formatMoney } from "@/lib/api-client";
import {
  cancelAction,
  confirmAction,
  isAssistantUnavailable,
  sendMessage,
  startConversation,
  transcribe,
  type ConfirmationCard,
  type ConversationSession,
  type ConversationSlot,
  type ConversationTurn,
} from "@/lib/conversation-client";
import { PushToTalkButton, canRecord, speak, type RecordingState } from "./push-to-talk-button";

/**
 * The assistant, inside the booking flow. tech-impl §28 · PRD §8.2, §8.3.
 *
 * §28 is explicit that the conversational interface lives in the normal booking
 * flow rather than on a page of its own, and `booking-flow.tsx` is already built
 * the way that requires: one route, one step machine, one owner for the hold.
 * This panel sits inside it and *drives* those steps — a customer can ask for a
 * time and then tap a different one, or start by clicking a service and finish
 * by typing.
 *
 * ## Nothing starts until somebody says something
 *
 * A conversation is a row, a credential and a budget. Minting one for every
 * visitor to a booking page would spend all three on people who came to click.
 * So the panel renders a prompt and an input, and the first message is what
 * creates the session.
 *
 * ## Every reply is a message key
 *
 * The server sends `{ key, params }` and never a sentence (tech-impl §20), so
 * the assistant's language is a translation like the rest of the product's. A
 * key with no translation renders as the key, which is ugly and visible — the
 * failure mode we want, rather than a blank bubble.
 */

/** What the panel tells the flow, so the form stays in step. */
export interface ConversationHandoff {
  serviceId?: string;
  providerId?: string;
  /** `YYYY-MM-DD`, from the slot the customer was offered. */
  day?: string;
}

export interface ConversationPanelProps {
  tenantSlug: string;
  /** Server's VOICE_MAX_DURATION_SECONDS. 30 by default (PRD §9.11). */
  maxRecordingSeconds?: number;
  /** The conversation narrowed something down; move the form to match. */
  onNarrow: (handoff: ConversationHandoff) => void;
  /** A booking exists. The flow takes over from here. */
  onBooked: (reference: string) => void;
}

interface Bubble {
  id: string;
  from: "customer" | "assistant";
  /** A key for the assistant, the customer's own words for them. */
  text: string;
  params?: Record<string, string | number>;
}

export function ConversationPanel({
  tenantSlug,
  maxRecordingSeconds = 30,
  onNarrow,
  onBooked,
}: ConversationPanelProps): React.ReactElement | null {
  const t = useTranslations("conversation");
  const locale = useLocale();

  const [session, setSession] = useState<ConversationSession | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [turn, setTurn] = useState<ConversationTurn | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<RecordingState>("IDLE");
  const [transcript, setTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [disclosed, setDisclosed] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const [microphone, setMicrophone] = useState(false);
  useEffect(() => {
    // Read after mount: `MediaRecorder` does not exist during the server render,
    // and deciding on the server would hide the button from everybody.
    setMicrophone(canRecord());
  }, []);

  const log = useRef(0);
  const nextId = (): string => `bubble-${(log.current += 1)}`;

  /** Fold the panel away and let the form take over (PRD §12.4). */
  const giveUp = useCallback((cause: unknown) => {
    if (isAssistantUnavailable(cause)) {
      setUnavailable(true);
      return;
    }

    setError(cause instanceof ApiError ? cause.message : String(cause));
  }, []);

  const absorb = useCallback(
    (next: ConversationTurn) => {
      setTurn(next);
      setBubbles((current) => [
        ...current,
        { id: nextId(), from: "assistant", text: next.message.key, ...(next.message.params === undefined ? {} : { params: next.message.params }) },
      ]);

      // Keep the form in step with whatever the conversation narrowed down, so
      // switching between talking and tapping is not a restart.
      const handoff: ConversationHandoff = {};
      if (next.services?.length === 1) handoff.serviceId = next.services[0]!.id;
      if (next.providers?.length === 1) handoff.providerId = next.providers[0]!.id;
      if (next.slots?.length) handoff.day = next.slots[0]!.startAt.slice(0, 10);
      if (Object.keys(handoff).length > 0) onNarrow(handoff);

      if (next.bookingReference !== null) onBooked(next.bookingReference);

      if (speaking) speak(t(next.message.key, next.message.params ?? {}), locale);
    },
    [locale, onBooked, onNarrow, speaking, t],
  );

  /** Start the conversation if there isn't one, then say the thing. */
  const say = useCallback(
    async (text: string, spoken: boolean): Promise<void> => {
      setBusy(true);
      setError(null);

      try {
        let current = session;

        if (current === null) {
          const started = await startConversation({
            tenantSlug,
            channel: spoken ? "VOICE" : "CHAT",
            locale,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          });

          current = { id: started.conversationId, token: started.sessionToken };
          setSession(current);
        }

        setBubbles((existing) => [...existing, { id: nextId(), from: "customer", text }]);

        absorb(await sendMessage({ session: current, text, spoken }));
      } catch (cause) {
        giveUp(cause);
      } finally {
        setBusy(false);
        setRecording("IDLE");
      }
    },
    [absorb, giveUp, locale, session, tenantSlug],
  );

  const onRecorded = useCallback(
    async (audio: Blob, durationMs: number): Promise<void> => {
      // A recording needs a conversation to belong to, and starting one costs a
      // round trip — so it happens here rather than at upload time.
      let current = session;

      try {
        setRecording("UPLOADING");

        if (current === null) {
          const started = await startConversation({
            tenantSlug,
            channel: "VOICE",
            locale,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          });
          current = { id: started.conversationId, token: started.sessionToken };
          setSession(current);
        }

        setRecording("TRANSCRIBING");
        const result = await transcribe({ session: current, audio, durationMs });

        // Transcript-first (PRD §10.1): shown for review, submitted separately.
        // The same act as typing, and the same input.
        setTranscript(result.transcript);
        setDraft(result.transcript);
        setRecording("REVIEWING");
      } catch (cause) {
        setRecording("ERROR");
        giveUp(cause);
      }
    },
    [giveUp, locale, session, tenantSlug],
  );

  const onConfirm = useCallback(
    async (card: ConfirmationCard): Promise<void> => {
      if (session === null) return;
      setBusy(true);

      try {
        absorb(await confirmAction({ session, actionId: card.actionId }));
      } catch (cause) {
        giveUp(cause);
      } finally {
        setBusy(false);
      }
    },
    [absorb, giveUp, session],
  );

  const onDecline = useCallback(
    async (card: ConfirmationCard): Promise<void> => {
      if (session === null) return;
      setBusy(true);

      try {
        absorb(await cancelAction({ session, actionId: card.actionId }));
      } catch (cause) {
        giveUp(cause);
      } finally {
        setBusy(false);
      }
    },
    [absorb, giveUp, session],
  );

  // The assistant is gone: no provider, no allowance, or the conversation ran
  // out. The form below is untouched, so there is nothing to say beyond why the
  // box disappeared.
  if (unavailable) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-400">
        {t("unavailable")}
      </p>
    );
  }

  const submit = (): void => {
    const text = draft.trim();
    if (text === "" || busy) return;

    const spoken = transcript !== null && text === transcript;
    setDraft("");
    setTranscript(null);
    void say(text, spoken);
  };

  return (
    <section
      aria-label={t("title")}
      className="flex flex-col gap-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles size={16} aria-hidden />
          {t("title")}
        </h2>

        {"speechSynthesis" in globalThis ? (
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
            <input
              type="checkbox"
              checked={speaking}
              onChange={(event) => setSpeaking(event.target.checked)}
            />
            {t("voice.speakReplies")}
          </label>
        ) : null}
      </header>

      {/* PRD §9.11: said before the first recording, not in a footer. */}
      {microphone && !disclosed ? (
        <p className="rounded-md bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-400">
          {t("aiDisclosure")}{" "}
          <button type="button" onClick={() => setDisclosed(true)} className="underline">
            {t("aiDisclosureAck")}
          </button>
        </p>
      ) : null}

      <div className="flex flex-col gap-2" aria-live="polite">
        {bubbles.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">{t("idlePrompt")}</p>
        ) : null}

        {bubbles.map((bubble) => (
          <p
            key={bubble.id}
            className={
              bubble.from === "customer"
                ? "self-end rounded-lg bg-brand-600/10 px-3 py-2 text-sm"
                : "self-start rounded-lg bg-slate-100 px-3 py-2 text-sm dark:bg-slate-900"
            }
          >
            {bubble.from === "customer" ? bubble.text : t(bubble.text, bubble.params ?? {})}
          </p>
        ))}
      </div>

      {turn?.slots?.length ? (
        <SlotChoices slots={turn.slots} locale={locale} onPick={(slot) => void say(slot, false)} />
      ) : null}

      {turn?.confirmation ? (
        <ConfirmationPanel
          card={turn.confirmation}
          locale={locale}
          busy={busy}
          onConfirm={() => void onConfirm(turn.confirmation!)}
          onDecline={() => void onDecline(turn.confirmation!)}
        />
      ) : null}

      {transcript !== null ? (
        <p className="text-xs text-slate-600 dark:text-slate-400">{t("voice.reviewHint")}</p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label htmlFor="conversation-input" className="sr-only">
          {t("inputLabel")}
        </label>
        <input
          id="conversation-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t("inputPlaceholder")}
          disabled={busy}
          className="flex-1 rounded-md border border-slate-300 bg-transparent px-3 py-2 text-sm disabled:opacity-60 dark:border-slate-700"
        />

        <button
          type="submit"
          disabled={busy || draft.trim() === ""}
          aria-label={t("send")}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-300 hover:border-brand-600 disabled:opacity-50 dark:border-slate-700"
        >
          <Send size={18} aria-hidden />
        </button>

        {/* tech-impl §19.3: no MediaRecorder, no microphone. The input above and
            the form below are the whole fallback, and both are always here. */}
        {microphone ? (
          <PushToTalkButton
            state={recording}
            onStateChange={setRecording}
            onRecorded={(audio, durationMs) => void onRecorded(audio, durationMs)}
            onError={(key) => setError(t(key))}
            maxDurationSeconds={maxRecordingSeconds}
            disabled={busy || !disclosed}
          />
        ) : null}
      </form>
    </section>
  );
}

/**
 * The times the assistant offered, as buttons.
 *
 * Picking one sends its ordinal as a message rather than calling a different
 * endpoint: PRD §25.2 requires a customer to be able to select a slot by voice
 * *or* touch, and routing both through the same turn is what stops the two ways
 * of choosing drifting apart.
 */
function SlotChoices({
  slots,
  locale,
  onPick,
}: {
  slots: ConversationSlot[];
  locale: string;
  onPick: (utterance: string) => void;
}): React.ReactElement {
  const t = useTranslations("conversation");

  return (
    <ul className="flex flex-wrap gap-2">
      {slots.map((slot, index) => (
        <li key={`${slot.providerId}-${slot.startAt}`}>
          <button
            type="button"
            onClick={() => onPick(t("slotOrdinal", { ordinal: index + 1 }))}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:border-brand-600 dark:border-slate-700"
          >
            <time dateTime={slot.startAt}>
              {new Date(slot.startAt).toLocaleString(locale, {
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
            <span className="block text-xs text-slate-600 dark:text-slate-400">
              {slot.providerName}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The confirmation card. PRD §9.14.
 *
 * The date is absolute and formatted here — never "tomorrow". A card that
 * repeats the customer's own relative phrase back at them confirms nothing,
 * because it cannot be wrong.
 *
 * Pressing Confirm is the only thing that reaches the confirm route. A spoken or
 * typed "yes" fills this card in; it does not bypass it.
 */
function ConfirmationPanel({
  card,
  locale,
  busy,
  onConfirm,
  onDecline,
}: {
  card: ConfirmationCard;
  locale: string;
  busy: boolean;
  onConfirm: () => void;
  onDecline: () => void;
}): React.ReactElement {
  const t = useTranslations("conversation");

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-brand-600/40 bg-brand-600/5 p-4">
      <h3 className="text-sm font-semibold">{t("confirm.title")}</h3>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-600 dark:text-slate-400">{t("confirm.service")}</dt>
        <dd>{card.serviceName}</dd>

        <dt className="text-slate-600 dark:text-slate-400">{t("confirm.provider")}</dt>
        <dd>{card.providerName}</dd>

        <dt className="text-slate-600 dark:text-slate-400">{t("confirm.when")}</dt>
        <dd>
          <time dateTime={card.startAt}>
            {new Date(card.startAt).toLocaleString(locale, {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </dd>

        {card.locationName ? (
          <>
            <dt className="text-slate-600 dark:text-slate-400">{t("confirm.where")}</dt>
            <dd>{card.locationName}</dd>
          </>
        ) : null}

        {card.customerName ? (
          <>
            <dt className="text-slate-600 dark:text-slate-400">{t("confirm.who")}</dt>
            <dd>{card.customerName}</dd>
          </>
        ) : null}

        {card.priceMinor !== null && card.currency ? (
          <>
            <dt className="text-slate-600 dark:text-slate-400">{t("confirm.price")}</dt>
            <dd>{formatMoney(card.priceMinor, card.currency, locale)}</dd>
          </>
        ) : null}
      </dl>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {t("confirm.yes")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDecline}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm disabled:opacity-60 dark:border-slate-700"
        >
          {t("confirm.no")}
        </button>
      </div>
    </div>
  );
}
