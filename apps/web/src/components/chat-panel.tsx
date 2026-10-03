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
import { Button } from "./ui/button";
import { Link } from "@/i18n/navigation";
import { renderMessage } from "@/lib/conversation-messages";
import { ChatCatalogueChoices } from "./chat-catalogue-choices";
import { Brand } from "./brand";
import { NativeSelect } from "@/components/ui/native-select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Locale = "en" | "hu" | "de" | "fr";
const languageNames = { hu: "Magyar", en: "English", de: "Deutsch", fr: "Français" } as const;
interface Bubble {
  id: string;
  from: "customer" | "assistant";
  text: string;
}
const guardCopy = {
  en: {
    start: "Start chat",
    warning: "One minute remaining.",
    paste: "Please type your message. Pasting and dropping text are disabled.",
    remaining: "Characters remaining",
    time: "Time remaining",
  },
  hu: {
    start: "Beszélgetés indítása",
    warning: "Egy perc van hátra.",
    paste: "Kérjük, gépelje be az üzenetet. A beillesztés és a szöveg behúzása nem engedélyezett.",
    remaining: "Hátralévő karakterek",
    time: "Hátralévő idő",
  },
  de: {
    start: "Chat starten",
    warning: "Noch eine Minute.",
    paste: "Bitte tippen Sie Ihre Nachricht. Einfügen und Ablegen von Text sind deaktiviert.",
    remaining: "Verbleibende Zeichen",
    time: "Verbleibende Zeit",
  },
  fr: {
    start: "Démarrer le chat",
    warning: "Il reste une minute.",
    paste: "Veuillez saisir votre message. Le collage et le dépôt de texte sont désactivés.",
    remaining: "Caractères restants",
    time: "Temps restant",
  },
};
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
  parentOrigin?: string | undefined;
}

export function ChatPanel(props: ChatPanelProps): React.ReactElement {
  const [language, setLanguage] = useState<Locale>("hu");
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
  const storageKey = `bam.chat.${tenantSlug}`;
  const g = guardCopy[language];
  const [clock, setClock] = useState(() => Date.now());
  const startKey = useRef<string | null>(null);
  const pendingMessage = useRef<{ text: string; key: string } | null>(null);
  const [session, setSession] = useState<ConversationSession | null>(null);
  const [turn, setTurn] = useState<ConversationTurn | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(true);
  const [available, setAvailable] = useState(true);
  const [personaName, setPersonaName] = useState("");
  const [businessName, setBusinessName] = useState("");
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
      startKey.current ??= crypto.randomUUID();
      const started = await startConversation({
        idempotencyKey: startKey.current,
        tenantSlug,
        locale: language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(token ? { managementToken: token } : {}),
      });
      startKey.current = null;
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
        if (!active) return;
        setPersonaName(config.personaName);
        setBusinessName(config.branding.businessName);
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
        }
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

  const secondsLeft = turn
    ? Math.max(0, Math.ceil((Date.parse(turn.expiresAt) - clock) / 1000))
    : null;
  const closed = Boolean(turn && (turn.closureReason || secondsLeft === 0));
  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [session]);
  useEffect(() => {
    if (secondsLeft !== 0 || !session || turn?.closureReason) return;
    void replayConversation(session)
      .then(setTurn)
      .catch(() => undefined);
  }, [secondsLeft, session, turn?.closureReason]);

  const sendText = async (value: string) => {
    const text = value.trim();
    if (!session || !text || busy || closed) return;
    if (
      Array.from(text).length >
      Math.min(turn?.maxMessageCharacters ?? 500, turn?.charactersRemaining ?? 5000)
    )
      return;
    if (pendingMessage.current?.text !== text)
      pendingMessage.current = { text, key: crypto.randomUUID() };
    setDraft("");
    setBusy(true);
    setError(null);
    setBubbles((rows) => [...rows, { id: `c-${++serial.current}`, from: "customer", text }]);
    try {
      const next = await sendMessage({
        session,
        text,
        idempotencyKey: pendingMessage.current.key,
        onTextDelta: (message) => {
          setBubbles((rows) => [
            ...rows.filter((row) => row.id !== "stream"),
            { id: "stream", from: "assistant", text: renderMessage(message, language) },
          ]);
        },
      });
      setBubbles((rows) => rows.filter((row) => row.id !== "stream"));
      pendingMessage.current = null;
      absorb(next);
    } catch (cause) {
      setDraft(text);
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
    if (!session || closed || busy) return;
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
    void begin(managementToken)
      .catch((cause: unknown) => {
        if (isAssistantUnavailable(cause)) setAvailable(false);
        else setError(cause instanceof ApiError ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-6">
        <Brand />
        {businessName ? (
          <span className="text-sm font-medium text-ink-muted">{businessName}</span>
        ) : null}
      </div>
      <section
        className="flex min-h-[min(40rem,80dvh)] w-full flex-col overflow-hidden rounded-xl border border-line bg-surface"
        aria-label={t.title}
        lang={language}
      >
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-surface-raised p-4 sm:p-6">
          <h1 className="flex items-center gap-3 font-display text-xl font-semibold">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-surface text-on-primary-surface">
              <Bot size={22} aria-hidden />
            </span>
            <span>
              {t.title}
              {personaName && personaName !== t.title ? (
                <span className="mt-1 block font-sans text-sm font-normal text-ink-muted">
                  {personaName}
                </span>
              ) : null}
            </span>
          </h1>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-sm text-ink-muted">{t.language}</span>
            <NativeSelect
              value={language}
              onChange={(event) => onLanguageChange(event.target.value as Locale)}
              className="w-auto"
            >
              {Object.entries(languageNames).map(([value, label]) => (
                <option key={value} value={value} lang={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </label>
          <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
            <RefreshCw size={16} aria-hidden />
            {session ? t.reset : g.start}
          </Button>
        </header>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-6" aria-live="polite">
          {!available ? (
            <p
              role="status"
              className="rounded-xl border border-line bg-surface-raised p-6 leading-relaxed"
            >
              {t.unavailable}
            </p>
          ) : null}
          {bubbles.length === 0 && available ? (
            <div className="my-auto flex flex-col items-center gap-4 px-4 py-10 text-center">
              <span className="flex size-16 items-center justify-center rounded-full bg-primary-surface text-on-primary-surface">
                <Bot size={28} aria-hidden />
              </span>
              <p className="font-display text-2xl font-semibold">{t.placeholder}</p>
              <p className="max-w-sm leading-relaxed text-ink-muted">{t.idle}</p>
            </div>
          ) : null}
          {bubbles.map((bubble) => (
            <p
              key={bubble.id}
              className={`max-w-[90%] whitespace-pre-wrap break-words rounded-xl px-4 py-3 text-base leading-relaxed sm:max-w-[85%] ${bubble.from === "customer" ? "self-end rounded-br-sm bg-primary text-on-primary" : "self-start rounded-bl-sm bg-surface-raised text-ink"}`}
            >
              {bubble.text}
            </p>
          ))}
          {closed &&
          !bubbles.some(
            (row) =>
              row.text === renderMessage({ key: "conversation.goodbye", ui: "NONE" }, language),
          ) ? (
            <p role="status">
              {renderMessage({ key: "conversation.goodbye", ui: "NONE" }, language)}
            </p>
          ) : null}
          {busy && available ? <p className="text-sm text-ink-muted">{t.working}</p> : null}
          <ChatCatalogueChoices
            services={turn?.message.ui === "SERVICE_LIST" ? turn.services : undefined}
            providers={turn?.message.ui === "PROVIDER_LIST" ? turn.providers : undefined}
            locale={language}
            disabled={busy || !available || closed}
            onPick={(name) => void sendText(name)}
          />
          {!closed && turn?.slots?.length ? (
            <SlotChoices
              slots={turn.slots}
              locale={language}
              onPick={(ordinal) => setDraft(t.slot(ordinal))}
            />
          ) : null}
          {!closed && turn?.confirmation ? (
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
        <footer className="border-t border-line bg-surface-raised p-4 sm:p-6">
          <div id="chat-limits" className="mb-3 text-sm">
            {turn ? (
              <p>
                {g.remaining}:{" "}
                {Math.max(0, turn.charactersRemaining - Array.from(draft.trim()).length)} ·{" "}
                {Array.from(draft.trim()).length}/{turn.maxMessageCharacters}
              </p>
            ) : null}
            {secondsLeft !== null ? (
              <p>
                {g.time}: {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
              </p>
            ) : null}
            {!closed && secondsLeft !== null && secondsLeft <= 60 ? (
              <p role="status">{g.warning}</p>
            ) : null}
          </div>
          <form
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
            onSubmit={(event) => void submit(event)}
          >
            <label className="col-span-2 mb-1 text-sm font-medium" htmlFor="chat-message">
              {t.placeholder}
            </label>
            <input
              id="chat-message"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onPaste={(event) => {
                event.preventDefault();
                setError(g.paste);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setError(g.paste);
              }}
              onBeforeInput={(event) => {
                if (["insertFromPaste", "insertFromDrop"].includes(event.nativeEvent.inputType)) {
                  event.preventDefault();
                  setError(g.paste);
                }
              }}
              aria-describedby="chat-limits"
              disabled={!available || busy || closed || !session}
              placeholder={t.placeholder}
              className="min-h-12 min-w-0 rounded-lg border border-line-strong bg-surface px-4"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="submit"
                  disabled={
                    !available ||
                    busy ||
                    closed ||
                    !session ||
                    !draft.trim() ||
                    Array.from(draft.trim()).length >
                      Math.min(turn?.maxMessageCharacters ?? 500, turn?.charactersRemaining ?? 5000)
                  }
                  aria-label={t.send}
                >
                  <Send size={17} aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t.send}</TooltipContent>
            </Tooltip>
          </form>
          <Button
            asChild
            variant="ghost"
            className="mt-3 w-full underline-offset-4 hover:underline"
          >
            <Link href={bookingHref}>{t.form}</Link>
          </Button>
        </footer>
      </section>
    </div>
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
            variant="outline"
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
        <Button variant="outline" disabled={busy} onClick={onDecline}>
          {t.decline}
        </Button>
      </div>
    </article>
  );
}
