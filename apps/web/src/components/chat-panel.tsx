"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Bot, RefreshCw, Send } from "lucide-react";
import { ApiError, formatMoney } from "@/lib/api-client";
import {
  assistantAvailability,
  cancelAction,
  confirmAction,
  isAssistantUnavailable,
  replayConversation,
  sendMessage,
  startConversation,
  type ConfirmationCard,
  type ConversationSession,
  type ConversationSlot,
  type ConversationTurn,
} from "@/lib/conversation-client";
import { Button, ButtonLink } from "./ui/button";

type Locale = "en" | "hu";
interface Bubble {
  id: string;
  from: "customer" | "assistant";
  text: string;
}
const copy = {
  en: {
    title: "AI receptionist",
    placeholder: "How can we help?",
    send: "Send",
    form: "Use booking form",
    reset: "New conversation",
    unavailable: "The assistant is unavailable. The booking form still works.",
    confirm: "Confirm",
    decline: "Not now",
    working: "Working…",
    idle: "Ask about services, availability, policies, or book an appointment.",
  },
  hu: {
    title: "AI recepciós",
    placeholder: "Miben segíthetünk?",
    send: "Küldés",
    form: "Foglalás űrlappal",
    reset: "Új beszélgetés",
    unavailable: "Az asszisztens most nem elérhető. A foglalási űrlap továbbra is működik.",
    confirm: "Megerősítés",
    decline: "Most nem",
    working: "Dolgozom…",
    idle: "Kérdezzen szolgáltatásokról, időpontokról, szabályokról, vagy foglaljon időpontot.",
  },
} as const;

function renderMessage(message: ConversationTurn["message"], locale: Locale): string {
  if (message.key === "conversation.answer") return String(message.params?.["answer"] ?? "");
  const known: Record<string, Record<Locale, string>> = {
    "conversation.greeting": { en: "Hello! How can I help?", hu: "Üdvözlöm! Miben segíthetek?" },
    "conversation.ask.service": {
      en: "Which service would you like?",
      hu: "Melyik szolgáltatást szeretné?",
    },
    "conversation.ask.provider": {
      en: "Do you prefer a provider?",
      hu: "Van választott szakembere?",
    },
    "conversation.ask.date": { en: "Which day works for you?", hu: "Melyik nap lenne megfelelő?" },
    "conversation.ask.slot": {
      en: "Choose one of these available times.",
      hu: "Válasszon az elérhető időpontok közül.",
    },
    "conversation.ask.name": {
      en: "What name should the booking be under?",
      hu: "Milyen névre rögzítsük a foglalást?",
    },
    "conversation.ask.contact": {
      en: "Please provide an email address or phone number.",
      hu: "Kérem, adjon meg e-mail-címet vagy telefonszámot.",
    },
    "conversation.confirm.prompt": {
      en: "Please review and confirm these details.",
      hu: "Kérem, ellenőrizze és erősítse meg az adatokat.",
    },
    "conversation.done": {
      en: "Your appointment has been created.",
      hu: "Az időpontfoglalás elkészült.",
    },
    "conversation.error.outOfScope": {
      en: "I can help with this business and its bookings.",
      hu: "A vállalkozással és a foglalásokkal kapcsolatban tudok segíteni.",
    },
    "conversation.error.noSlots": {
      en: "I could not find an available time in that range.",
      hu: "Ebben az időszakban nem találtam szabad időpontot.",
    },
  };
  return known[message.key]?.[locale] ?? message.key;
}

export function ChatPanel({
  tenantSlug,
  locale,
  bookingHref,
  managementToken,
  parentOrigin,
}: {
  tenantSlug: string;
  locale: string;
  bookingHref: string;
  managementToken?: string | undefined;
  parentOrigin?: string | undefined;
}): React.ReactElement {
  const language: Locale = locale === "hu" ? "hu" : "en";
  const t = copy[language];
  const storageKey = `bam.chat.${tenantSlug}.${language}`;
  const [session, setSession] = useState<ConversationSession | null>(null);
  const [turn, setTurn] = useState<ConversationTurn | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(true);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const serial = useRef(0);

  const absorb = useCallback(
    (next: ConversationTurn) => {
      setTurn(next);
      setBubbles((rows) => [
        ...rows,
        {
          id: `a-${++serial.current}`,
          from: "assistant",
          text: renderMessage(next.message, language),
        },
      ]);
    },
    [language],
  );

  const begin = useCallback(
    async (token?: string) => {
      const started = await startConversation({
        tenantSlug,
        locale: language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(token ? { managementToken: token } : {}),
      });
      const nextSession = { id: started.conversationId, token: started.sessionToken };
      sessionStorage.setItem(storageKey, JSON.stringify(nextSession));
      setAvailable(true);
      setError(null);
      setSession(nextSession);
      absorb(started);
    },
    [absorb, language, storageKey, tenantSlug],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const config = await assistantAvailability(tenantSlug);
        if (!active || !config.available) {
          setAvailable(false);
          return;
        }
        setAvailable(true);
        const stored = sessionStorage.getItem(storageKey);
        if (stored) {
          const existing = JSON.parse(stored) as ConversationSession;
          const replay = await replayConversation(existing);
          if (!active) return;
          setSession(existing);
          setTurn(replay);
          setBubbles(
            replay.messages
              .filter((message) => message.sender !== "SYSTEM")
              .map((message) => ({
                id: message.id,
                from: message.sender === "CUSTOMER" ? "customer" : "assistant",
                text:
                  message.sender === "CUSTOMER"
                    ? message.content
                    : renderMessage({ key: message.content, ui: "NONE" }, language),
              })),
          );
        } else await begin(managementToken);
      } catch (cause) {
        if (isAssistantUnavailable(cause)) setAvailable(false);
        else setError(cause instanceof ApiError ? cause.message : String(cause));
      } finally {
        if (active) setBusy(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [begin, language, managementToken, storageKey, tenantSlug]);

  useEffect(() => {
    if (!parentOrigin || window.parent === window) return;
    window.parent.postMessage(
      { type: "bam-chat:resize", height: document.documentElement.scrollHeight },
      parentOrigin,
    );
  }, [bubbles, parentOrigin, turn]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!session || !text || busy) return;
    setDraft("");
    setBusy(true);
    setError(null);
    setBubbles((rows) => [...rows, { id: `c-${++serial.current}`, from: "customer", text }]);
    try {
      const next = await sendMessage({
        session,
        text,
        onTextDelta: (message) => {
          setBubbles((rows) => [
            ...rows.filter((row) => row.id !== "stream"),
            { id: "stream", from: "assistant", text: renderMessage(message, language) },
          ]);
        },
      });
      setBubbles((rows) => rows.filter((row) => row.id !== "stream"));
      absorb(next);
    } catch (cause) {
      if (isAssistantUnavailable(cause)) setAvailable(false);
      else setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const act = async (card: ConfirmationCard, confirm: boolean) => {
    if (!session) return;
    setBusy(true);
    try {
      absorb(
        confirm
          ? await confirmAction({ session, actionId: card.actionId })
          : await cancelAction({ session, actionId: card.actionId }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    sessionStorage.removeItem(storageKey);
    setSession(null);
    setTurn(null);
    setBubbles([]);
    setError(null);
    setBusy(true);
    void begin()
      .catch((cause: unknown) => {
        if (isAssistantUnavailable(cause)) setAvailable(false);
        else setError(cause instanceof ApiError ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  return (
    <section
      className="mx-auto flex min-h-[32rem] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-sm"
      aria-label={t.title}
    >
      <header className="flex items-center justify-between border-b border-line bg-surface-raised px-5 py-4">
        <h1 className="flex items-center gap-2 font-semibold">
          <Bot size={20} aria-hidden />
          {t.title}
        </h1>
        <Button variant="ghost" size="sm" onClick={reset}>
          <RefreshCw size={16} aria-hidden />
          {t.reset}
        </Button>
      </header>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-5" aria-live="polite">
        {!available ? (
          <p className="rounded-lg border border-line p-4 text-sm">{t.unavailable}</p>
        ) : null}
        {bubbles.length === 0 && available ? (
          <p className="text-sm text-ink-muted">{t.idle}</p>
        ) : null}
        {bubbles.map((bubble) => (
          <p
            key={bubble.id}
            className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${bubble.from === "customer" ? "self-end bg-primary text-on-primary" : "self-start bg-surface-raised text-ink"}`}
          >
            {bubble.text}
          </p>
        ))}
        {busy && available ? <p className="text-sm text-ink-muted">{t.working}</p> : null}
        {turn?.slots?.length ? (
          <SlotChoices
            slots={turn.slots}
            locale={language}
            onPick={(ordinal) =>
              setDraft(
                language === "hu"
                  ? `A(z) ${ordinal}. időpontot kérem`
                  : `I would like option ${ordinal}`,
              )
            }
          />
        ) : null}
        {turn?.confirmation ? (
          <Confirmation
            card={turn.confirmation}
            locale={language}
            busy={busy}
            onConfirm={() => void act(turn.confirmation!, true)}
            onDecline={() => void act(turn.confirmation!, false)}
          />
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
      <footer className="border-t border-line p-4">
        <form className="flex gap-2" onSubmit={(event) => void submit(event)}>
          <label className="sr-only" htmlFor="chat-message">
            {t.placeholder}
          </label>
          <input
            id="chat-message"
            maxLength={2000}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!available || busy}
            placeholder={t.placeholder}
            className="min-h-11 flex-1 rounded-lg border border-line-strong bg-transparent px-3"
          />
          <Button type="submit" disabled={!available || busy || !draft.trim()} aria-label={t.send}>
            <Send size={17} aria-hidden />
          </Button>
        </form>
        <ButtonLink href={bookingHref} variant="secondary" className="mt-3 w-full">
          {t.form}
        </ButtonLink>
      </footer>
    </section>
  );
}

function SlotChoices({
  slots,
  locale,
  onPick,
}: {
  slots: ConversationSlot[];
  locale: Locale;
  onPick: (ordinal: number) => void;
}): React.ReactElement {
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {slots.map((slot, index) => (
        <li key={`${slot.providerId}-${slot.startAt}`}>
          <Button
            variant="secondary"
            className="h-full w-full flex-col"
            onClick={() => onPick(index + 1)}
          >
            <time dateTime={slot.startAt}>
              {new Date(slot.startAt).toLocaleString(locale, {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
            <span className="text-xs text-ink-muted">{slot.providerName}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}
function Confirmation({
  card,
  locale,
  busy,
  onConfirm,
  onDecline,
}: {
  card: ConfirmationCard;
  locale: Locale;
  busy: boolean;
  onConfirm: () => void;
  onDecline: () => void;
}): React.ReactElement {
  const t = copy[locale];
  return (
    <article className="rounded-xl border border-primary bg-primary-surface p-4">
      <h2 className="font-semibold">{card.serviceName}</h2>
      <p className="mt-1 text-sm">
        {card.providerName} ·{" "}
        <time dateTime={card.startAt}>{new Date(card.startAt).toLocaleString(locale)}</time>
      </p>
      {card.priceMinor !== null && card.currency ? (
        <p className="text-sm">{formatMoney(card.priceMinor, card.currency, locale)}</p>
      ) : null}
      <div className="mt-4 flex gap-2">
        <Button disabled={busy} onClick={onConfirm}>
          {t.confirm}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onDecline}>
          {t.decline}
        </Button>
      </div>
    </article>
  );
}
