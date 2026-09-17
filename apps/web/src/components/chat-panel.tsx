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
import { renderMessage } from "@/lib/conversation-messages";
import { ChatCatalogueChoices } from "./chat-catalogue-choices";

type Locale = "en" | "hu" | "de" | "fr";
const languageNames = { hu: "Magyar", en: "English", de: "Deutsch", fr: "Français" } as const;
interface Bubble {
  id: string;
  from: "customer" | "assistant";
  text: string;
}
const copy = {
  en: {
    language: "Language",
    slot: (ordinal: number) => `I would like option ${ordinal}`,
    title: "AI Assistant",
    placeholder: "How can we help?",
    send: "Send",
    form: "Use booking form",
    reset: "New conversation",
    unavailable: "The AI Assistant is unavailable. The booking form still works.",
    confirm: "Confirm",
    decline: "Not now",
    working: "Working…",
    idle: "Ask about services, availability, policies, or book an appointment.",
  },
  hu: {
    language: "Nyelv",
    slot: (ordinal: number) => `A(z) ${ordinal}. időpontot kérem`,
    title: "AI Asszistens",
    placeholder: "Miben segíthetünk?",
    send: "Küldés",
    form: "Foglalás űrlappal",
    reset: "Új beszélgetés",
    unavailable: "Az AI Asszistens most nem elérhető. A foglalási űrlap továbbra is működik.",
    confirm: "Megerősítés",
    decline: "Most nem",
    working: "Dolgozom…",
    idle: "Kérdezzen szolgáltatásokról, időpontokról, szabályokról, vagy foglaljon időpontot.",
  },
  de: {
    language: "Sprache",
    slot: (ordinal: number) => `Ich möchte Option ${ordinal}`,
    title: "KI-Rezeption",
    placeholder: "Wie können wir helfen?",
    send: "Senden",
    form: "Buchungsformular verwenden",
    reset: "Neues Gespräch",
    unavailable:
      "Der Assistent ist derzeit nicht verfügbar. Das Buchungsformular funktioniert weiterhin.",
    confirm: "Bestätigen",
    decline: "Jetzt nicht",
    working: "Einen Moment…",
    idle: "Fragen Sie nach Leistungen, Terminen oder Richtlinien, oder buchen Sie einen Termin.",
  },
  fr: {
    language: "Langue",
    slot: (ordinal: number) => `Je souhaite l’option ${ordinal}`,
    title: "Réceptionniste IA",
    placeholder: "Comment pouvons-nous vous aider ?",
    send: "Envoyer",
    form: "Utiliser le formulaire de réservation",
    reset: "Nouvelle conversation",
    unavailable: "L’assistant est indisponible. Le formulaire de réservation reste disponible.",
    confirm: "Confirmer",
    decline: "Pas maintenant",
    working: "Un instant…",
    idle: "Posez vos questions sur les prestations, les disponibilités ou les conditions, ou réservez un rendez-vous.",
  },
} as const;

interface ChatPanelProps {
  tenantSlug: string;
  bookingHref: string;
  managementToken?: string | undefined;
  initialLanguage?: Locale | undefined;
  parentOrigin?: string | undefined;
}

export function ChatPanel(props: ChatPanelProps): React.ReactElement {
  const [language, setLanguage] = useState<Locale>(props.initialLanguage ?? "hu");
  // Each language has its own session; remounting clears pending UI and drafts.
  return (
    <ChatConversation
      key={`${props.tenantSlug}.${language}`}
      {...props}
      language={language}
      onLanguageChange={setLanguage}
    />
  );
}

function ChatConversation({
  tenantSlug,
  language,
  onLanguageChange,
  bookingHref,
  managementToken,
  parentOrigin,
}: ChatPanelProps & {
  language: Locale;
  onLanguageChange: (locale: Locale) => void;
}): React.ReactElement {
  const t = copy[language];
  const storageKey = `bam.chat.${tenantSlug}.${language}`;
  const [session, setSession] = useState<ConversationSession | null>(null);
  const [turn, setTurn] = useState<ConversationTurn | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(true);
  const [available, setAvailable] = useState(true);
  const [personaName, setPersonaName] = useState("");
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
      // Booking management sessions stay in memory, separate from general chat.
      if (!managementToken) sessionStorage.setItem(storageKey, JSON.stringify(nextSession));
      setAvailable(true);
      setError(null);
      setSession(nextSession);
      absorb(started);
    },
    [absorb, language, managementToken, storageKey, tenantSlug],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const config = await assistantAvailability(tenantSlug);
        if (!active) return;
        setPersonaName(config.personaName);
        if (!active || !config.available) {
          setAvailable(false);
          return;
        }
        setAvailable(true);
        const stored = managementToken ? null : sessionStorage.getItem(storageKey);
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

  const sendText = async (value: string) => {
    const text = value.trim();
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
  const submit = (event: FormEvent) => {
    event.preventDefault();
    return sendText(draft);
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
    if (!managementToken) sessionStorage.removeItem(storageKey);
    setSession(null);
    setTurn(null);
    setBubbles([]);
    setError(null);
    setBusy(true);
    void begin(managementToken)
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
      lang={language}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface-raised px-5 py-4">
        <h1 className="flex items-center gap-2 font-semibold">
          <Bot size={20} aria-hidden />
          <span>
            {t.title}
            {personaName && personaName !== t.title ? (
              <span className="block text-xs font-normal text-ink-muted">{personaName}</span>
            ) : null}
          </span>
        </h1>
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only">{t.language}</span>
          <select
            value={language}
            onChange={(event) => onLanguageChange(event.target.value as Locale)}
            className="min-h-11 rounded-lg border border-line-strong bg-surface px-3 text-ink"
          >
            {Object.entries(languageNames).map(([value, label]) => (
              <option key={value} value={value} lang={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
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
        <ChatCatalogueChoices
          services={turn?.message.ui === "SERVICE_LIST" ? turn.services : undefined}
          providers={turn?.message.ui === "PROVIDER_LIST" ? turn.providers : undefined}
          locale={language}
          disabled={busy || !available}
          onPick={(name) => void sendText(name)}
        />
        {turn?.slots?.length ? (
          <SlotChoices
            slots={turn.slots}
            locale={language}
            onPick={(ordinal) => setDraft(t.slot(ordinal))}
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
