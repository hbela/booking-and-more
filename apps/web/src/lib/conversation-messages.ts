import type { AssistantMessage } from "./conversation-client";

type Locale = "hu" | "en" | "de" | "fr";

export const conversationMessages: Record<string, Record<Locale, string>> = {
  "conversation.greeting": {
    en: "Hello! How can I help?",
    hu: "Üdvözlöm! Miben segíthetek?",
    de: "Hallo! Wie kann ich helfen?",
    fr: "Bonjour ! Comment puis-je vous aider ?",
  },
  "conversation.ask.service": {
    en: "Which service would you like?",
    hu: "Melyik szolgáltatást szeretné?",
    de: "Welche Leistung wünschen Sie?",
    fr: "Quelle prestation souhaitez-vous ?",
  },
  "conversation.ask.provider": {
    en: "Do you prefer a provider?",
    hu: "Van választott szakembere?",
    de: "Bevorzugen Sie eine bestimmte Fachkraft?",
    fr: "Avez-vous une préférence pour un professionnel ?",
  },
  "conversation.ask.date": {
    en: "Which day works for you?",
    hu: "Melyik nap lenne megfelelő?",
    de: "Welcher Tag passt Ihnen?",
    fr: "Quel jour vous conviendrait ?",
  },
  "conversation.ask.slot": {
    en: "Choose one of these available times.",
    hu: "Válasszon az elérhető időpontok közül.",
    de: "Wählen Sie einen verfügbaren Termin.",
    fr: "Choisissez un créneau disponible.",
  },
  "conversation.ask.name": {
    en: "What name should the booking be under?",
    hu: "Milyen névre rögzítsük a foglalást?",
    de: "Auf welchen Namen soll die Buchung erfolgen?",
    fr: "À quel nom faut-il réserver ?",
  },
  "conversation.ask.contact": {
    en: "Please provide an email address or phone number.",
    hu: "Kérem, adjon meg e-mail-címet vagy telefonszámot.",
    de: "Bitte geben Sie eine E-Mail-Adresse oder Telefonnummer an.",
    fr: "Veuillez indiquer une adresse e-mail ou un numéro de téléphone.",
  },
  "conversation.confirm.prompt": {
    en: "Please review and confirm these details.",
    hu: "Kérem, ellenőrizze és erősítse meg az adatokat.",
    de: "Bitte prüfen und bestätigen Sie diese Angaben.",
    fr: "Veuillez vérifier et confirmer ces informations.",
  },
  "conversation.searching": {
    en: "Looking for available appointments…",
    hu: "Szabad időpontokat keresek…",
    de: "Verfügbare Termine werden gesucht…",
    fr: "Recherche de créneaux disponibles…",
  },
  "conversation.holding": {
    en: "Holding your selected time…",
    hu: "A kiválasztott időpontot ideiglenesen lefoglalom…",
    de: "Ihr Termin wird vorläufig reserviert…",
    fr: "Votre créneau est temporairement réservé…",
  },
  "conversation.confirming": {
    en: "Confirming your booking…",
    hu: "A foglalás megerősítése folyamatban…",
    de: "Ihre Buchung wird bestätigt…",
    fr: "Confirmation de votre réservation…",
  },
  "conversation.done": {
    en: "Your appointment has been created.",
    hu: "Az időpontfoglalás elkészült.",
    de: "Ihr Termin wurde gebucht.",
    fr: "Votre rendez-vous a été réservé.",
  },
  "conversation.cancelled": {
    en: "This conversation has ended.",
    hu: "Ez a beszélgetés lezárult.",
    de: "Dieses Gespräch wurde beendet.",
    fr: "Cette conversation est terminée.",
  },
  "conversation.expired": {
    en: "This conversation has expired. Please start a new conversation.",
    hu: "A beszélgetés lejárt. Kérem, indítson új beszélgetést.",
    de: "Dieses Gespräch ist abgelaufen. Bitte starten Sie ein neues Gespräch.",
    fr: "Cette conversation a expiré. Veuillez en démarrer une nouvelle.",
  },
  "conversation.error.unclear": {
    en: "I’m not sure I understood. Would you like to book an appointment or ask about our services?",
    hu: "Nem vagyok biztos benne, hogy jól értettem. Időpontot szeretne foglalni, vagy a szolgáltatásokról érdeklődik?",
    de: "Ich habe Sie nicht verstanden. Möchten Sie einen Termin buchen oder nach unseren Leistungen fragen?",
    fr: "Je ne suis pas sûr de vous avoir compris. Souhaitez-vous réserver un rendez-vous ou vous renseigner sur nos prestations ?",
  },
  "conversation.error.outOfScope": {
    en: "I can help with this business and its bookings.",
    hu: "A vállalkozással és a foglalásokkal kapcsolatban tudok segíteni.",
    de: "Ich kann bei Fragen zu diesem Unternehmen und seinen Buchungen helfen.",
    fr: "Je peux vous aider concernant cet établissement et ses réservations.",
  },
  "conversation.error.noSlots": {
    en: "I could not find an available time in that range. Please try another day.",
    hu: "Ebben az időszakban nem találtam szabad időpontot. Kérem, válasszon másik napot.",
    de: "Keine freien Termine gefunden. Bitte wählen Sie einen anderen Tag.",
    fr: "Aucun créneau disponible. Veuillez choisir un autre jour.",
  },
  "conversation.error.date": {
    en: "Which date would you like? Please include the day and month.",
    hu: "Melyik dátumot szeretné? Kérem, adja meg a hónapot és a napot.",
    de: "Welches Datum wünschen Sie? Bitte geben Sie Tag und Monat an.",
    fr: "Quelle date souhaitez-vous ? Veuillez préciser le jour et le mois.",
  },
  "conversation.error.time": {
    en: "What time would you prefer?",
    hu: "Melyik időpont lenne megfelelő?",
    de: "Welche Uhrzeit bevorzugen Sie?",
    fr: "Quel horaire préférez-vous ?",
  },
  "conversation.error.slotTaken": {
    en: "That time is no longer available. Please choose another.",
    hu: "Ez az időpont már nem elérhető. Kérem, válasszon másikat.",
    de: "Dieser Termin ist nicht mehr verfügbar. Bitte wählen Sie einen anderen.",
    fr: "Ce créneau n’est plus disponible. Veuillez en choisir un autre.",
  },
  "conversation.error.holdExpired": {
    en: "Your temporary hold has expired. Please choose an available time again.",
    hu: "Az időpont ideiglenes lefoglalása lejárt. Kérem, válasszon újra szabad időpontot.",
    de: "Ihre vorläufige Reservierung ist abgelaufen. Bitte wählen Sie erneut einen Termin.",
    fr: "Votre réservation temporaire a expiré. Veuillez choisir à nouveau un créneau.",
  },
  "conversation.error.offerExpired": {
    en: "This confirmation has expired. Please request it again.",
    hu: "Ez a megerősítési lehetőség lejárt. Kérem, kérje újra.",
    de: "Diese Bestätigung ist abgelaufen. Bitte fordern Sie sie erneut an.",
    fr: "Cette confirmation a expiré. Veuillez la demander à nouveau.",
  },
  "conversation.error.alreadyConfirmed": {
    en: "This action has already been confirmed.",
    hu: "Ezt a műveletet már megerősítették.",
    de: "Diese Aktion wurde bereits bestätigt.",
    fr: "Cette action a déjà été confirmée.",
  },
  "conversation.error.turnLimit": {
    en: "This conversation has reached its limit. Please start a new one or use the booking form.",
    hu: "A beszélgetés elérte a megengedett üzenetszámot. Kérem, indítson újat, vagy használja a foglalási űrlapot.",
    de: "Das Nachrichtenlimit ist erreicht. Bitte starten Sie ein neues Gespräch oder nutzen Sie das Buchungsformular.",
    fr: "La limite de messages est atteinte. Veuillez démarrer une nouvelle conversation ou utiliser le formulaire de réservation.",
  },
  "conversation.error.sessionExpired": {
    en: "Your session has expired. Please start a new conversation.",
    hu: "A munkamenet lejárt. Kérem, indítson új beszélgetést.",
    de: "Ihre Sitzung ist abgelaufen. Bitte starten Sie ein neues Gespräch.",
    fr: "Votre session a expiré. Veuillez démarrer une nouvelle conversation.",
  },
  "conversation.error.quota": {
    en: "The AI Assistant is unavailable right now. Please use the booking form.",
    hu: "Az AI Asszistens most nem elérhető. Kérem, használja a foglalási űrlapot.",
    de: "Der Assistent ist nicht verfügbar. Bitte nutzen Sie das Buchungsformular.",
    fr: "L’assistant est indisponible. Veuillez utiliser le formulaire de réservation.",
  },
  "conversation.error.transcription": {
    en: "I could not understand the recording. Please try again or type your message.",
    hu: "Nem sikerült megértenem a hangfelvételt. Kérem, próbálja újra, vagy írja le az üzenetét.",
    de: "Ich konnte die Aufnahme nicht verstehen. Bitte versuchen Sie es erneut oder schreiben Sie Ihre Nachricht.",
    fr: "Je n’ai pas compris l’enregistrement. Veuillez réessayer ou saisir votre message.",
  },
};

export function renderMessage(message: AssistantMessage, locale: Locale): string {
  if (message.key === "conversation.answer") return String(message.params?.["answer"] ?? "");
  return (
    conversationMessages[message.key]?.[locale] ??
    conversationMessages["conversation.error.unclear"]![locale]
  );
}
