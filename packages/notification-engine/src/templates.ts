import { NotificationTypes, type Locale, type NotificationType } from "./types.js";

/**
 * Rendering a message is a pure function of values, so it lives here rather
 * than in the worker. tech-impl §27, §38.
 *
 * No template engine and no HTML framework: these are transactional emails of a
 * dozen lines, and every dependency added here is one the engine's "no runtime
 * dependencies" claim would have to give up. Interpolation is explicit, and
 * every interpolated value is escaped — see {@link escapeHtml}.
 *
 * Both a text and an HTML body are produced for every message. A text part is
 * not politeness: an email with only an HTML body scores worse with spam
 * filters, and a provisioning link that lands in spam is a customer who never
 * onboards.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Values a template may interpolate. Everything is a string by the time it arrives. */
export interface OrganizationCreatedValues {
  organizationName: string;
  ownerName: string;
  acceptUrl: string;
  /** Formatted for the recipient's locale by the caller, not here. */
  expiresAt: string;
}

const COPY: Record<Locale, { subject: (name: string) => string; body: OrganizationCreatedCopy }> = {
  hu: {
    subject: (name) => `${name} — a fiókja készen áll`,
    body: {
      greeting: (owner) => `Kedves ${owner}!`,
      intro: (org) => `Létrehoztuk a(z) ${org} szervezet fiókját a Booking and More rendszerében.`,
      action: "A belépéshez és a jelszava beállításához kattintson az alábbi gombra:",
      button: "Fiók aktiválása",
      fallback: "Ha a gomb nem működik, másolja be ezt a címet a böngészőjébe:",
      expiry: (when) => `A link ${when}-ig érvényes.`,
      next: "Belépés után felveheti a szolgáltatásait, munkatársait és nyitvatartását.",
      signoff: "Üdvözlettel,\na Booking and More csapata",
      // No password is ever emailed (phase-9 §2.5); say so, because a customer
      // expecting one will otherwise write in asking where it is.
      noPassword: "Jelszót nem küldünk e-mailben — a linken saját jelszót állíthat be.",
    },
  },
  en: {
    subject: (name) => `${name} — your account is ready`,
    body: {
      greeting: (owner) => `Dear ${owner},`,
      intro: (org) => `We have created the account for ${org} on Booking and More.`,
      action: "Click below to sign in and choose your password:",
      button: "Activate your account",
      fallback: "If the button does not work, paste this address into your browser:",
      expiry: (when) => `The link is valid until ${when}.`,
      next: "Once inside, you can add your services, staff and opening hours.",
      signoff: "Best regards,\nthe Booking and More team",
      noPassword: "We never email passwords — the link lets you set your own.",
    },
  },
};

interface OrganizationCreatedCopy {
  greeting: (owner: string) => string;
  intro: (organization: string) => string;
  action: string;
  button: string;
  fallback: string;
  expiry: (when: string) => string;
  next: string;
  signoff: string;
  noPassword: string;
}

/**
 * Escape a value for interpolation into HTML.
 *
 * Every value below goes through this. An organization name is typed by a
 * salesperson into a form, which makes it untrusted input, and an unescaped
 * `&` in "Smith & Sons" is a broken email long before anyone tries anything
 * malicious with it.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

export function renderOrganizationCreated(
  locale: Locale,
  values: OrganizationCreatedValues,
): RenderedEmail {
  const { subject, body } = COPY[locale];

  const text = [
    body.greeting(values.ownerName),
    "",
    body.intro(values.organizationName),
    "",
    body.action,
    values.acceptUrl,
    "",
    body.expiry(values.expiresAt),
    body.noPassword,
    "",
    body.next,
    "",
    body.signoff,
  ].join("\n");

  const html = layout(`
    <p>${escapeHtml(body.greeting(values.ownerName))}</p>
    <p>${escapeHtml(body.intro(values.organizationName))}</p>
    <p>${escapeHtml(body.action)}</p>
    <p>
      <a href="${escapeHtml(values.acceptUrl)}" style="${BUTTON_STYLE}">
        ${escapeHtml(body.button)}
      </a>
    </p>
    <p style="${MUTED_STYLE}">${escapeHtml(body.fallback)}<br />
      <a href="${escapeHtml(values.acceptUrl)}">${escapeHtml(values.acceptUrl)}</a>
    </p>
    <p style="${MUTED_STYLE}">${escapeHtml(body.expiry(values.expiresAt))}<br />
      ${escapeHtml(body.noPassword)}
    </p>
    <p>${escapeHtml(body.next)}</p>
    <p style="${MUTED_STYLE}">${escapeHtml(body.signoff).replace(/\n/gu, "<br />")}</p>
  `);

  return { subject: subject(values.organizationName), html, text };
}

const BUTTON_STYLE =
  "display:inline-block;padding:12px 24px;border-radius:6px;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600";

const MUTED_STYLE = "color:#64748b;font-size:14px";

/**
 * Inline styles and a table-free single column, because email clients are not
 * browsers: Outlook ignores `<style>` blocks, and Gmail strips `<head>`.
 */
function layout(content: string): string {
  return [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.6;color:#0f172a;max-width:560px;margin:0 auto;padding:24px">',
    content.trim(),
    "</div>",
  ].join("\n");
}

// --- Subscription link -----------------------------------------------------

export interface SubscriptionLinkValues {
  organizationName: string;
  recipientName: string;
  /** Already localized by the caller; this file does no plan naming. */
  planName: string;
  paymentUrl: string;
}

interface SubscriptionLinkCopy {
  greeting: (name: string) => string;
  intro: (organization: string, plan: string) => string;
  action: string;
  button: string;
  fallback: string;
  /** The reason this arrives as an email rather than a button in the app. */
  forwardable: string;
  secure: string;
  signoff: string;
}

const SUBSCRIPTION_COPY: Record<
  Locale,
  { subject: (organization: string) => string; body: SubscriptionLinkCopy }
> = {
  hu: {
    subject: (organization) => `${organization} — előfizetési link`,
    body: {
      greeting: (name) => `Kedves ${name}!`,
      intro: (organization, plan) =>
        `Íme a(z) ${organization} előfizetési linkje a(z) ${plan} csomagra.`,
      action: "A fizetés elindításához kattintson az alábbi gombra:",
      button: "Előfizetés indítása",
      fallback: "Ha a gomb nem működik, másolja be ezt a címet a böngészőjébe:",
      forwardable:
        "Ezt az e-mailt továbbküldheti annak, aki a számlázást intézi — a fizetéshez nem szükséges belépni.",
      secure:
        "A fizetés a Stripe biztonságos oldalán történik. Bankkártyaadatokat soha nem kezelünk és nem tárolunk.",
      signoff: "Üdvözlettel,\na Booking and More csapata",
    },
  },
  en: {
    subject: (organization) => `${organization} — your subscription link`,
    body: {
      greeting: (name) => `Dear ${name},`,
      intro: (organization, plan) =>
        `Here is the subscription link for ${organization} on the ${plan} plan.`,
      action: "Click below to start your subscription:",
      button: "Start subscription",
      fallback: "If the button does not work, paste this address into your browser:",
      forwardable:
        "You can forward this email to whoever handles your billing — no account is needed to pay.",
      secure: "Payment happens on Stripe's secure page. We never see or store card details.",
      signoff: "Best regards,\nthe Booking and More team",
    },
  },
};

/**
 * The payment link, in an email that can be forwarded.
 *
 * `forwardable` earns its place in the copy: it is the actual reason this is an
 * email rather than a button in the dashboard
 * (phase-9-subscription-and-activation.md §1.1). A recipient who does not know
 * they may forward it will either pay on a card that is not theirs to use, or
 * write in asking.
 */
export function renderSubscriptionLink(
  locale: Locale,
  values: SubscriptionLinkValues,
): RenderedEmail {
  const { subject, body } = SUBSCRIPTION_COPY[locale];

  const text = [
    body.greeting(values.recipientName),
    "",
    body.intro(values.organizationName, values.planName),
    "",
    body.action,
    values.paymentUrl,
    "",
    body.forwardable,
    body.secure,
    "",
    body.signoff,
  ].join("\n");

  const html = layout(`
    <p>${escapeHtml(body.greeting(values.recipientName))}</p>
    <p>${escapeHtml(body.intro(values.organizationName, values.planName))}</p>
    <p>${escapeHtml(body.action)}</p>
    <p>
      <a href="${escapeHtml(values.paymentUrl)}" style="${BUTTON_STYLE}">
        ${escapeHtml(body.button)}
      </a>
    </p>
    <p style="${MUTED_STYLE}">${escapeHtml(body.fallback)}<br />
      <a href="${escapeHtml(values.paymentUrl)}">${escapeHtml(values.paymentUrl)}</a>
    </p>
    <p style="${MUTED_STYLE}">${escapeHtml(body.forwardable)}<br />
      ${escapeHtml(body.secure)}
    </p>
    <p style="${MUTED_STYLE}">${escapeHtml(body.signoff).replace(/\n/gu, "<br />")}</p>
  `);

  return { subject: subject(values.organizationName), html, text };
}

// --- Subscription confirmed ------------------------------------------------

export interface SubscriptionConfirmedValues {
  organizationName: string;
  recipientName: string;
  /** Already localized by the caller; this file does no plan naming. */
  planName: string;
  /** True while the free trial runs — it changes what the money line may say. */
  trial: boolean;
  /**
   * When the trial converts, or when the period renews. Already formatted by
   * the caller; empty when Stripe did not give us one.
   */
  renewsOn: string;
  /** Where they configure the thing they have just paid for. */
  dashboardUrl: string;
}

interface SubscriptionConfirmedCopy {
  greeting: (name: string) => string;
  intro: (organization: string, plan: string) => string;
  /** Said only during a trial, and it is the line that prevents a dispute. */
  trialCharge: (date: string) => string;
  paidCharge: (date: string) => string;
  unlocked: string;
  action: string;
  button: string;
  fallback: string;
  manage: string;
  signoff: string;
}

const SUBSCRIPTION_CONFIRMED_COPY: Record<
  Locale,
  { subject: (organization: string) => string; body: SubscriptionConfirmedCopy }
> = {
  hu: {
    subject: (organization) => `${organization} — az előfizetés aktív`,
    body: {
      greeting: (name) => `Kedves ${name}!`,
      intro: (organization, plan) =>
        `Köszönjük! A(z) ${organization} előfizetése aktív a(z) ${plan} csomagon.`,
      trialCharge: (date) =>
        `A próbaidőszak ${date} napján ér véget — az első terhelés ekkor történik. Addig bármikor lemondhatja, és nem számlázunk semmit.`,
      paidCharge: (date) => `A következő megújulás időpontja: ${date}.`,
      unlocked:
        "Mostantól minden funkció elérhető: felvehet szolgáltatókat, szolgáltatásokat és helyszíneket, majd elindíthatja a foglalásokat.",
      action: "Kezdje itt:",
      button: "Ugrás a vezérlőpultra",
      fallback: "Ha a gomb nem működik, másolja be ezt a címet a böngészőjébe:",
      manage:
        "A számlázást — bankkártya módosítása, számlák letöltése, lemondás — a vezérlőpult Előfizetés oldalán kezelheti.",
      signoff: "Üdvözlettel,\na Booking and More csapata",
    },
  },
  en: {
    subject: (organization) => `${organization} — your subscription is active`,
    body: {
      greeting: (name) => `Dear ${name},`,
      intro: (organization, plan) =>
        `Thank you. ${organization} is now subscribed on the ${plan} plan.`,
      trialCharge: (date) =>
        `Your free trial ends on ${date}, and that is when the first charge is taken. Cancel any time before then and you will not be billed.`,
      paidCharge: (date) => `Your next renewal is on ${date}.`,
      unlocked:
        "Everything is unlocked: add your providers, services and locations, then start taking bookings.",
      action: "Start here:",
      button: "Go to your dashboard",
      fallback: "If the button does not work, paste this address into your browser:",
      manage:
        "You can change your card, download invoices or cancel from the Subscription page in your dashboard.",
      signoff: "Best regards,\nthe Booking and More team",
    },
  },
};

/**
 * The receipt for the whole onboarding path.
 *
 * Until this existed the owner paid on Stripe's hosted page and heard nothing
 * from us again — the one moment in onboarding where silence reads as failure,
 * because they have just handed over a card. Stripe emails its own receipt, but
 * that confirms a *payment*; this confirms that the thing they bought is ready,
 * and points at it.
 *
 * **The charge line is the part that matters.** During a trial it names the date
 * of the first charge and the fact that cancelling before it costs nothing —
 * the same reasoning as the trial-ending email, applied earlier: a charge
 * nobody expected is the commonest reason a new customer disputes one, and the
 * cheapest place to prevent that is the email they actually read, which is this
 * one. It is dropped entirely rather than guessed at when Stripe gave us no
 * date.
 */
export function renderSubscriptionConfirmed(
  locale: Locale,
  values: SubscriptionConfirmedValues,
): RenderedEmail {
  const { subject, body } = SUBSCRIPTION_CONFIRMED_COPY[locale];

  const chargeLine =
    values.renewsOn === ""
      ? []
      : [values.trial ? body.trialCharge(values.renewsOn) : body.paidCharge(values.renewsOn)];

  const text = [
    body.greeting(values.recipientName),
    "",
    body.intro(values.organizationName, values.planName),
    ...chargeLine,
    "",
    body.unlocked,
    "",
    body.action,
    values.dashboardUrl,
    "",
    body.manage,
    "",
    body.signoff,
  ].join("\n");

  const html = layout(`
    <p>${escapeHtml(body.greeting(values.recipientName))}</p>
    <p>${escapeHtml(body.intro(values.organizationName, values.planName))}</p>
    ${chargeLine.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
    <p>${escapeHtml(body.unlocked)}</p>
    <p>${escapeHtml(body.action)}</p>
    <p>
      <a href="${escapeHtml(values.dashboardUrl)}" style="${BUTTON_STYLE}">
        ${escapeHtml(body.button)}
      </a>
    </p>
    <p style="${MUTED_STYLE}">${escapeHtml(body.fallback)}<br />
      <a href="${escapeHtml(values.dashboardUrl)}">${escapeHtml(values.dashboardUrl)}</a>
    </p>
    <p style="${MUTED_STYLE}">${escapeHtml(body.manage)}</p>
    <p style="${MUTED_STYLE}">${escapeHtml(body.signoff).replace(/\n/gu, "<br />")}</p>
  `);

  return { subject: subject(values.organizationName), html, text };
}

// --- Trial ending ----------------------------------------------------------

export interface TrialEndingValues {
  organizationName: string;
  recipientName: string;
  planName: string;
  /** Already formatted by the caller; this file does no date formatting. */
  trialEndsOn: string;
  /** Where to change or cancel before the charge. */
  billingUrl: string;
}

const TRIAL_ENDING_COPY: Record<
  Locale,
  {
    subject: (organization: string) => string;
    body: {
      greeting: (name: string) => string;
      intro: (organization: string, date: string) => string;
      charge: (plan: string) => string;
      nothingToDo: string;
      change: string;
      button: string;
      signoff: string;
    };
  }
> = {
  hu: {
    subject: (organization) => `${organization} — a próbaidőszak hamarosan véget ér`,
    body: {
      greeting: (name) => `Kedves ${name}!`,
      intro: (organization, date) =>
        `A(z) ${organization} ingyenes próbaidőszaka ${date} napján véget ér.`,
      charge: (plan) => `Ezt követően a(z) ${plan} csomag díját számítjuk fel a megadott kártyára.`,
      nothingToDo: "Ha folytatni szeretné, nincs teendője — minden marad a régiben.",
      change: "Ha módosítaná vagy lemondaná, itt teheti meg a próbaidőszak vége előtt:",
      button: "Előfizetés kezelése",
      signoff: "Üdvözlettel,\na Booking and More csapata",
    },
  },
  en: {
    subject: (organization) => `${organization} — your free trial ends soon`,
    body: {
      greeting: (name) => `Dear ${name},`,
      intro: (organization, date) => `The free trial for ${organization} ends on ${date}.`,
      charge: (plan) => `After that we will charge your card for the ${plan} plan.`,
      nothingToDo: "If you would like to continue, there is nothing to do — everything carries on.",
      change: "To change or cancel, you can do so before the trial ends:",
      button: "Manage subscription",
      signoff: "Best regards,\nthe Booking and More team",
    },
  },
};

/**
 * The trial is about to become a bill.
 *
 * The card is already on file, so this is not a call to action — which is why
 * `nothingToDo` is in the copy. An email that reads like a demand makes a
 * customer who was going to stay open the cancellation page. What it must do is
 * name the date and the amount's plan, because an unexpected charge is the
 * commonest reason a new customer disputes one, and a dispute costs more than
 * the month it recovers.
 */
export function renderTrialEnding(locale: Locale, values: TrialEndingValues): RenderedEmail {
  const { subject, body } = TRIAL_ENDING_COPY[locale];

  const text = [
    body.greeting(values.recipientName),
    "",
    body.intro(values.organizationName, values.trialEndsOn),
    body.charge(values.planName),
    "",
    body.nothingToDo,
    "",
    body.change,
    values.billingUrl,
    "",
    body.signoff,
  ].join("\n");

  const html = layout(`
    <p>${escapeHtml(body.greeting(values.recipientName))}</p>
    <p>${escapeHtml(body.intro(values.organizationName, values.trialEndsOn))}</p>
    <p>${escapeHtml(body.charge(values.planName))}</p>
    <p>${escapeHtml(body.nothingToDo)}</p>
    <p>${escapeHtml(body.change)}</p>
    <p>
      <a href="${escapeHtml(values.billingUrl)}" style="${BUTTON_STYLE}">
        ${escapeHtml(body.button)}
      </a>
    </p>
    <p style="${MUTED_STYLE}">${escapeHtml(body.signoff).replace(/\n/gu, "<br />")}</p>
  `);

  return { subject: subject(values.organizationName), html, text };
}

// --- Payment failed --------------------------------------------------------

export interface PaymentFailedValues {
  organizationName: string;
  recipientName: string;
  /** Already formatted and localized by the caller, or null when unknown. */
  amount: string | null;
  billingUrl: string;
}

const PAYMENT_FAILED_COPY: Record<
  Locale,
  {
    subject: (organization: string) => string;
    body: {
      greeting: (name: string) => string;
      intro: (organization: string) => string;
      amount: (amount: string) => string;
      stillWorking: string;
      action: string;
      button: string;
      retrying: string;
      signoff: string;
    };
  }
> = {
  hu: {
    subject: (organization) => `${organization} — sikertelen fizetés`,
    body: {
      greeting: (name) => `Kedves ${name}!`,
      intro: (organization) => `A(z) ${organization} előfizetési díját nem sikerült levonni.`,
      amount: (amount) => `Az esedékes összeg: ${amount}.`,
      stillWorking: "A szolgáltatás egyelőre változatlanul működik.",
      action: "Kérjük, frissítse a bankkártyaadatait:",
      button: "Fizetési mód frissítése",
      retrying:
        "Néhány napon belül újra megkíséreljük a levonást. Ha addig sem sikerül, az előfizetés megszűnik.",
      signoff: "Üdvözlettel,\na Booking and More csapata",
    },
  },
  en: {
    subject: (organization) => `${organization} — payment failed`,
    body: {
      greeting: (name) => `Dear ${name},`,
      intro: (organization) => `We could not take the subscription payment for ${organization}.`,
      amount: (amount) => `The amount due is ${amount}.`,
      stillWorking: "Your service is still working as normal for now.",
      action: "Please update your card details:",
      button: "Update payment method",
      retrying:
        "We will try again over the next few days. If it still fails, the subscription will end.",
      signoff: "Best regards,\nthe Booking and More team",
    },
  },
};

/**
 * A declined renewal, while there is still time to fix it.
 *
 * `stillWorking` and `retrying` are both load-bearing. Access continues because
 * Stripe's dunning is the grace period
 * (docs/phase-9-subscription-lifecycle.md §2.3), so an email implying the
 * service has stopped would be false — and one that does not mention the
 * deadline lets a customer ignore it until they are suspended. Saying both is
 * what makes this email actionable rather than alarming.
 */
export function renderPaymentFailed(locale: Locale, values: PaymentFailedValues): RenderedEmail {
  const { subject, body } = PAYMENT_FAILED_COPY[locale];

  const amountLine = values.amount === null ? [] : [body.amount(values.amount)];

  const text = [
    body.greeting(values.recipientName),
    "",
    body.intro(values.organizationName),
    ...amountLine,
    body.stillWorking,
    "",
    body.action,
    values.billingUrl,
    "",
    body.retrying,
    "",
    body.signoff,
  ].join("\n");

  const html = layout(`
    <p>${escapeHtml(body.greeting(values.recipientName))}</p>
    <p>${escapeHtml(body.intro(values.organizationName))}</p>
    ${amountLine.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n")}
    <p>${escapeHtml(body.stillWorking)}</p>
    <p>${escapeHtml(body.action)}</p>
    <p>
      <a href="${escapeHtml(values.billingUrl)}" style="${BUTTON_STYLE}">
        ${escapeHtml(body.button)}
      </a>
    </p>
    <p style="${MUTED_STYLE}">${escapeHtml(body.retrying)}</p>
    <p style="${MUTED_STYLE}">${escapeHtml(body.signoff).replace(/\n/gu, "<br />")}</p>
  `);

  return { subject: subject(values.organizationName), html, text };
}

// --- Provider invited ------------------------------------------------------

export interface ProviderInvitedValues {
  organizationName: string;
  /** The clinic's own name for this person — `Provider.displayName`. */
  providerName: string;
  /** Who pressed Invite. The caller falls back to the organization. */
  invitedByName: string;
  acceptUrl: string;
  /** Formatted for the recipient's locale by the caller, not here. */
  expiresAt: string;
}

interface ProviderInvitedCopy {
  greeting: (provider: string) => string;
  intro: (inviter: string, organization: string) => string;
  /**
   * What a provider gets, which is not what an owner gets. The organization
   * email's "add your services, staff and opening hours" would promise exactly
   * the three navigation items a PROVIDER does not have
   * (phase-9-provider-onboarding §2.9).
   */
  whatYouGet: string;
  action: string;
  button: string;
  fallback: string;
  expiry: (when: string) => string;
  /**
   * Said out loud because a recipient expecting a password will otherwise write
   * in asking where it is — and because a predecessor project emailed plaintext
   * passwords, which is the practice this whole design exists to avoid.
   */
  noPassword: string;
  /**
   * New relative to the organization email, and earned: this address was typed
   * by a clinic into a provider form, so a typo sends this to a stranger.
   */
  unexpected: string;
  signoff: string;
}

const PROVIDER_INVITED_COPY: Record<
  Locale,
  { subject: (organization: string) => string; body: ProviderInvitedCopy }
> = {
  hu: {
    // Names the organization, not the provider: the recipient *is* the provider.
    subject: (organization) => `${organization} — állítsa be a belépését`,
    body: {
      greeting: (provider) => `Kedves ${provider}!`,
      intro: (inviter, organization) =>
        `${inviter} meghívta Önt a(z) ${organization} rendszerébe a Booking and More-on.`,
      whatYouGet:
        "Saját belépést kap: beállíthatja a munkaidejét, felvehet szabadságot és zárva tartást, és láthatja a saját foglalásait.",
      action: "A belépéshez és a jelszava beállításához kattintson az alábbi gombra:",
      button: "Belépés beállítása",
      fallback: "Ha a gomb nem működik, másolja be ezt a címet a böngészőjébe:",
      expiry: (when) => `A link ${when}-ig érvényes.`,
      noPassword: "Jelszót nem küldünk e-mailben — a linken saját jelszót állíthat be.",
      unexpected: "Ha nem számított erre a levélre, hagyja figyelmen kívül — a link magától lejár.",
      signoff: "Üdvözlettel,\na Booking and More csapata",
    },
  },
  en: {
    subject: (organization) => `${organization} — set up your login`,
    body: {
      greeting: (provider) => `Dear ${provider},`,
      intro: (inviter, organization) =>
        `${inviter} has invited you to join ${organization} on Booking and More.`,
      whatYouGet:
        "You get your own login: set your working hours, add time off and closures, and see your own bookings.",
      action: "Click below to sign in and choose your password:",
      button: "Set up your login",
      fallback: "If the button does not work, paste this address into your browser:",
      expiry: (when) => `The link is valid until ${when}.`,
      noPassword: "We never email passwords — the link lets you choose your own.",
      unexpected: "If you were not expecting this, ignore it — the link expires on its own.",
      signoff: "Kind regards,\nthe Booking and More team",
    },
  },
};

export function renderProviderInvited(
  locale: Locale,
  values: ProviderInvitedValues,
): RenderedEmail {
  const { subject, body } = PROVIDER_INVITED_COPY[locale];

  const text = [
    body.greeting(values.providerName),
    "",
    body.intro(values.invitedByName, values.organizationName),
    body.whatYouGet,
    "",
    body.action,
    values.acceptUrl,
    "",
    body.expiry(values.expiresAt),
    body.noPassword,
    "",
    body.unexpected,
    "",
    body.signoff,
  ].join("\n");

  const html = layout(`
    <p>${escapeHtml(body.greeting(values.providerName))}</p>
    <p>${escapeHtml(body.intro(values.invitedByName, values.organizationName))}</p>
    <p>${escapeHtml(body.whatYouGet)}</p>
    <p>${escapeHtml(body.action)}</p>
    <p>
      <a href="${escapeHtml(values.acceptUrl)}" style="${BUTTON_STYLE}">
        ${escapeHtml(body.button)}
      </a>
    </p>
    <p style="${MUTED_STYLE}">${escapeHtml(body.fallback)}<br />
      <a href="${escapeHtml(values.acceptUrl)}">${escapeHtml(values.acceptUrl)}</a>
    </p>
    <p style="${MUTED_STYLE}">${escapeHtml(body.expiry(values.expiresAt))}<br />
      ${escapeHtml(body.noPassword)}
    </p>
    <p style="${MUTED_STYLE}">${escapeHtml(body.unexpected)}</p>
    <p style="${MUTED_STYLE}">${escapeHtml(body.signoff).replace(/\n/gu, "<br />")}</p>
  `);

  return { subject: subject(values.organizationName), html, text };
}

// --- Bookings --------------------------------------------------------------

/**
 * What every booking email says about the appointment itself.
 *
 * All five templates print the same block, because a customer scanning any of
 * them is looking for the same six facts. Every value arrives already formatted
 * and localized — the times in the appointment's own zone, the price through
 * `Intl` — for the reason the whole file follows: this package has no runtime
 * dependencies and no opinion about zones.
 */
export interface BookingValues {
  /** The clinic. Booking emails are signed by them, not by the platform. */
  organizationName: string;
  /** `customer_name_snapshot` — what the customer was called when they booked. */
  customerName: string;
  serviceName: string;
  providerName: string;
  /** Date and time, formatted for the recipient in the appointment's zone. */
  when: string;
  locationName: string | null;
  locationAddress: string | null;
  /** Formatted with its currency, or null when the booking records no price. */
  price: string | null;
  /** The short human reference — what a customer reads out on the phone. */
  reference: string;
}

interface DetailLabels {
  when: string;
  service: string;
  provider: string;
  place: string;
  price: string;
  reference: string;
}

const DETAIL_LABELS: Record<Locale, DetailLabels> = {
  hu: {
    when: "Időpont",
    service: "Szolgáltatás",
    provider: "Kolléga",
    place: "Helyszín",
    price: "Ár",
    reference: "Azonosító",
  },
  en: {
    when: "When",
    service: "Service",
    provider: "With",
    place: "Where",
    price: "Price",
    reference: "Reference",
  },
};

/** `[label, value]` for everything the booking actually has. */
function detailPairs(locale: Locale, values: BookingValues): [string, string][] {
  const labels = DETAIL_LABELS[locale];

  const place = [values.locationName, values.locationAddress]
    .filter((part): part is string => part !== null && part !== "")
    .join(", ");

  return [
    [labels.when, values.when],
    [labels.service, values.serviceName],
    [labels.provider, values.providerName],
    // A single-location clinic may name no location on the booking at all, and
    // an empty "Where:" line reads as missing information rather than as a
    // clinic with one address.
    ...(place === "" ? [] : ([[labels.place, place]] as [string, string][])),
    ...(values.price === null ? [] : ([[labels.price, values.price]] as [string, string][])),
    [labels.reference, values.reference],
  ];
}

function detailsText(locale: Locale, values: BookingValues): string[] {
  return detailPairs(locale, values).map(([label, value]) => `${label}: ${value}`);
}

function detailsHtml(locale: Locale, values: BookingValues): string {
  const rows = detailPairs(locale, values)
    .map(
      ([label, value]) =>
        `<tr><td style="${DETAIL_LABEL_STYLE}">${escapeHtml(label)}</td><td style="${DETAIL_VALUE_STYLE}">${escapeHtml(value)}</td></tr>`,
    )
    .join("");

  // The one table in the file, and it earns it: label/value pairs are what a
  // table is for, and every email client aligns one correctly. `layout()`'s
  // "table-free" note is about layout scaffolding, not about tabular data.
  return `<table role="presentation" style="${DETAIL_TABLE_STYLE}"><tbody>${rows}</tbody></table>`;
}

const DETAIL_TABLE_STYLE =
  "border-collapse:collapse;margin:16px 0;background:#f8fafc;border-radius:6px;width:100%";
const DETAIL_LABEL_STYLE = "padding:8px 12px;color:#64748b;font-size:14px;vertical-align:top";
const DETAIL_VALUE_STYLE = "padding:8px 12px;font-weight:600;vertical-align:top";

interface BookingCopy {
  greeting: (customer: string) => string;
  /** Signed by the clinic; the customer has no relationship with the platform. */
  signoff: (organization: string) => string;
  fallback: string;
}

const BOOKING_COMMON: Record<Locale, BookingCopy> = {
  hu: {
    greeting: (customer) => `Kedves ${customer}!`,
    signoff: (organization) => `Üdvözlettel,\n${organization}`,
    fallback: "Ha a gomb nem működik, másolja be ezt a címet a böngészőjébe:",
  },
  en: {
    greeting: (customer) => `Dear ${customer},`,
    signoff: (organization) => `Kind regards,\n${organization}`,
    fallback: "If the button does not work, paste this address into your browser:",
  },
};

/**
 * The shape every booking email shares: greeting, a sentence, the details, then
 * whatever that particular message adds.
 *
 * Assembled once so the five templates differ only where they mean to. `lines`
 * are paragraphs after the details block; `action` is the optional button.
 */
function bookingEmail(
  locale: Locale,
  values: BookingValues,
  parts: {
    subject: string;
    intro: string;
    lines: string[];
    action?: { label: string; url: string; lead: string } | undefined;
    muted: string[];
  },
): RenderedEmail {
  const common = BOOKING_COMMON[locale];

  const text = [
    common.greeting(values.customerName),
    "",
    parts.intro,
    "",
    ...detailsText(locale, values),
    "",
    ...(parts.lines.length === 0 ? [] : [...parts.lines, ""]),
    ...(parts.action === undefined ? [] : [parts.action.lead, parts.action.url, ""]),
    ...(parts.muted.length === 0 ? [] : [...parts.muted, ""]),
    common.signoff(values.organizationName),
  ].join("\n");

  const html = layout(`
    <p>${escapeHtml(common.greeting(values.customerName))}</p>
    <p>${escapeHtml(parts.intro)}</p>
    ${detailsHtml(locale, values)}
    ${parts.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n")}
    ${
      parts.action === undefined
        ? ""
        : `<p>${escapeHtml(parts.action.lead)}</p>
    <p>
      <a href="${escapeHtml(parts.action.url)}" style="${BUTTON_STYLE}">
        ${escapeHtml(parts.action.label)}
      </a>
    </p>
    <p style="${MUTED_STYLE}">${escapeHtml(common.fallback)}<br />
      <a href="${escapeHtml(parts.action.url)}">${escapeHtml(parts.action.url)}</a>
    </p>`
    }
    ${parts.muted.map((line) => `<p style="${MUTED_STYLE}">${escapeHtml(line)}</p>`).join("\n")}
    <p style="${MUTED_STYLE}">${escapeHtml(common.signoff(values.organizationName)).replace(/\n/gu, "<br />")}</p>
  `);

  return { subject: parts.subject, html, text };
}

// --- Booking requested -----------------------------------------------------

export interface BookingRequestedValues extends BookingValues {
  /**
   * Normally present — this email is minted where the raw token still exists —
   * but nullable so a payload that somehow lacks one produces an email without a
   * button rather than no email at all.
   */
  manageUrl: string | null;
}

const REQUESTED_COPY: Record<
  Locale,
  {
    subject: (organization: string) => string;
    intro: (organization: string) => string;
    notYet: string;
    lead: string;
    button: string;
    change: string;
  }
> = {
  hu: {
    subject: (organization) => `${organization} — foglalási kérelmét megkaptuk`,
    intro: (organization) => `Köszönjük! A(z) ${organization} megkapta a foglalási kérelmét.`,
    // The whole reason this template exists: a "thank you" that does not say
    // this would be read as a confirmation, and the customer would turn up.
    notYet:
      "Ez még nem végleges foglalás — kollégáink visszaigazolják, és arról külön e-mailt küldünk.",
    lead: "A kérelmét itt tekintheti meg vagy vonhatja vissza:",
    button: "Foglalás megtekintése",
    change: "Őrizze meg ezt a levelet: a fenti link az egyetlen módja, hogy online kezelje.",
  },
  en: {
    subject: (organization) => `${organization} — we have your booking request`,
    intro: (organization) => `Thank you. ${organization} has received your booking request.`,
    notYet:
      "This is not a confirmed appointment yet — we will check it and email you again once it is accepted.",
    lead: "You can view or withdraw your request here:",
    button: "View your request",
    change: "Keep this email: the link above is the only way to manage it online.",
  },
};

/**
 * A booking for a service with `requiresApproval`.
 *
 * `notYet` is the load-bearing line. Every other email in this section confirms
 * something; this one deliberately does not, and a customer who reads it as a
 * confirmation turns up to an appointment nobody accepted.
 */
export function renderBookingRequested(
  locale: Locale,
  values: BookingRequestedValues,
): RenderedEmail {
  const copy = REQUESTED_COPY[locale];

  return bookingEmail(locale, values, {
    subject: copy.subject(values.organizationName),
    intro: copy.intro(values.organizationName),
    lines: [copy.notYet],
    ...(values.manageUrl === null
      ? {}
      : { action: { label: copy.button, url: values.manageUrl, lead: copy.lead } }),
    // "Keep this email" only means something when the email has the link in it.
    muted: values.manageUrl === null ? [] : [copy.change],
  });
}

// --- Booking confirmation --------------------------------------------------

export interface BookingConfirmationValues extends BookingValues {
  /**
   * Null when staff accepted a pending request: the raw token existed only at
   * the moment the booking was made, and the customer already holds it from the
   * requested email (docs/phase-5-booking-notifications.md §2.1).
   */
  manageUrl: string | null;
  /** `Tenant.cancellationPolicy` — free text, printed as written, or null. */
  cancellationPolicy: string | null;
}

const CONFIRMATION_COPY: Record<
  Locale,
  {
    subject: (organization: string) => string;
    intro: (organization: string) => string;
    lead: string;
    button: string;
    useOriginal: string;
    late: string;
  }
> = {
  hu: {
    subject: (organization) => `${organization} — foglalása visszaigazolva`,
    intro: (organization) => `Foglalását a(z) ${organization} visszaigazolta. Várjuk Önt!`,
    lead: "Időpontját itt módosíthatja vagy mondhatja le:",
    button: "Foglalás kezelése",
    useOriginal:
      "Módosításhoz vagy lemondáshoz használja a foglaláskor kapott levélben lévő linket, vagy hívjon minket.",
    late: "Kérjük, jelezze időben, ha nem tud jönni — így másnak tudjuk adni az időpontot.",
  },
  en: {
    subject: (organization) => `${organization} — your appointment is confirmed`,
    intro: (organization) =>
      `${organization} has confirmed your appointment. We look forward to it.`,
    lead: "You can change or cancel it here:",
    button: "Manage your booking",
    useOriginal:
      "To change or cancel, use the link in the email you received when you booked, or call us.",
    late: "Please let us know in good time if you cannot make it, so we can offer the slot to someone else.",
  },
};

/**
 * The appointment is on.
 *
 * The button is present or absent depending on where this was triggered from,
 * and the copy changes with it rather than leaving a dead end: a straight-through
 * booking carries its token here, while an accepted request does not, and the
 * customer already holds a working link from the requested email.
 */
export function renderBookingConfirmation(
  locale: Locale,
  values: BookingConfirmationValues,
): RenderedEmail {
  const copy = CONFIRMATION_COPY[locale];

  return bookingEmail(locale, values, {
    subject: copy.subject(values.organizationName),
    intro: copy.intro(values.organizationName),
    lines: [],
    ...(values.manageUrl === null
      ? {}
      : { action: { label: copy.button, url: values.manageUrl, lead: copy.lead } }),
    muted: [
      ...(values.manageUrl === null ? [copy.useOriginal] : []),
      copy.late,
      // Printed as the clinic wrote it. Nothing here interprets it — it is free
      // text, and phase-4 §5.1 is why no number is derived from it.
      ...(values.cancellationPolicy === null || values.cancellationPolicy === ""
        ? []
        : [values.cancellationPolicy]),
    ],
  });
}

// --- Booking rescheduled ---------------------------------------------------

export interface BookingUpdatedValues extends BookingValues {
  /**
   * Where the appointment used to be, formatted like `when` — or null when the
   * event did not record it. The line is dropped rather than guessed at: the
   * details block already names the appointment by reference.
   */
  previousWhen: string | null;
}

const UPDATED_COPY: Record<
  Locale,
  {
    subject: (organization: string) => string;
    intro: (organization: string) => string;
    moved: (from: string) => string;
    stillWorks: string;
  }
> = {
  hu: {
    subject: (organization) => `${organization} — foglalása új időpontra került`,
    intro: (organization) => `A(z) ${organization} foglalását áthelyeztük. Az új időpont:`,
    moved: (from) => `Korábbi időpont: ${from}.`,
    stillWorks:
      "A foglaláskor kapott link továbbra is érvényes — azon módosíthat vagy mondhat le. Ha nem találja, hívjon minket.",
  },
  en: {
    subject: (organization) => `${organization} — your appointment has moved`,
    intro: (organization) => `Your appointment with ${organization} has been moved. It is now:`,
    moved: (from) => `It was previously ${from}.`,
    stillWorks:
      "The link from your booking email still works — use it to change or cancel. If you cannot find it, call us.",
  },
};

/**
 * The appointment moved.
 *
 * No button, deliberately. A public reschedule was authenticated by the token
 * and could carry it; a staff reschedule has no token at all, and an email whose
 * button appears only when the *customer* moved the booking is an inconsistency
 * no recipient could account for (§2.1). The link they already hold still works.
 */
export function renderBookingUpdated(locale: Locale, values: BookingUpdatedValues): RenderedEmail {
  const copy = UPDATED_COPY[locale];

  return bookingEmail(locale, values, {
    subject: copy.subject(values.organizationName),
    intro: copy.intro(values.organizationName),
    lines: values.previousWhen === null ? [] : [copy.moved(values.previousWhen)],
    muted: [copy.stillWorks],
  });
}

// --- Booking cancelled -----------------------------------------------------

export interface BookingCancelledValues extends BookingValues {
  /** The clinic's public booking page — not a secret, so always safe to carry. */
  bookingUrl: string | null;
}

const CANCELLED_COPY: Record<
  Locale,
  {
    subject: (organization: string) => string;
    intro: (organization: string) => string;
    gone: string;
    lead: string;
    button: string;
  }
> = {
  hu: {
    subject: (organization) => `${organization} — foglalása lemondva`,
    intro: (organization) => `A(z) ${organization} alábbi foglalását lemondtuk.`,
    gone: "Erre az időpontra már nem várjuk. Ha tévedés történt, kérjük, hívjon minket.",
    lead: "Új időpontot bármikor foglalhat:",
    button: "Új időpont foglalása",
  },
  en: {
    subject: (organization) => `${organization} — your appointment is cancelled`,
    intro: (organization) => `The following appointment with ${organization} has been cancelled.`,
    gone: "We are no longer expecting you at this time. If this is a mistake, please call us.",
    lead: "You can book a new appointment whenever you like:",
    button: "Book another time",
  },
};

/**
 * The appointment is off.
 *
 * The only link here is the public booking page, which is not a credential — so
 * unlike the manage link it can be built from the tenant's slug at any time,
 * and offering it is the difference between a dead end and a rebooking.
 */
export function renderBookingCancelled(
  locale: Locale,
  values: BookingCancelledValues,
): RenderedEmail {
  const copy = CANCELLED_COPY[locale];

  return bookingEmail(locale, values, {
    subject: copy.subject(values.organizationName),
    intro: copy.intro(values.organizationName),
    lines: [copy.gone],
    ...(values.bookingUrl === null
      ? {}
      : { action: { label: copy.button, url: values.bookingUrl, lead: copy.lead } }),
    muted: [],
  });
}

// --- Booking reminder ------------------------------------------------------

export type BookingReminderValues = BookingValues;

const REMINDER_COPY: Record<
  Locale,
  {
    subject: (organization: string) => string;
    intro: (organization: string) => string;
    change: string;
    thanks: string;
  }
> = {
  hu: {
    subject: (organization) => `${organization} — emlékeztető a közelgő időpontjáról`,
    intro: (organization) => `Emlékeztetjük a(z) ${organization} közelgő időpontjára:`,
    // No link, and it points at where to find one instead. The reminder row is
    // written when the booking is made and sent days later, so a manage URL
    // here would sit in the database for that whole period (§2.2).
    change:
      "Ha módosítana vagy lemondaná, használja a foglaláskor kapott levélben lévő linket, vagy hívjon minket.",
    thanks: "Ha nem tud jönni, kérjük, jelezze — így másnak tudjuk adni az időpontot.",
  },
  en: {
    subject: (organization) => `${organization} — a reminder about your appointment`,
    intro: (organization) => `A reminder about your upcoming appointment with ${organization}:`,
    change:
      "To change or cancel, use the link in the email you received when you booked, or call us.",
    thanks: "If you cannot make it, please let us know so we can offer the slot to someone else.",
  },
};

/**
 * The appointment is soon.
 *
 * Deliberately linkless. Its row is written when the booking is made and sends
 * `BOOKING_REMINDER_LEAD_HOURS` before the appointment, so a manage URL in the
 * payload would leave working credentials in the database for the whole booking
 * horizon — the exposure phase-4 §4's "only the SHA-256 hash is stored"
 * safeguard exists to prevent. Recorded in §2.2 as a deliberate trade.
 */
export function renderBookingReminder(
  locale: Locale,
  values: BookingReminderValues,
): RenderedEmail {
  const copy = REMINDER_COPY[locale];

  return bookingEmail(locale, values, {
    subject: copy.subject(values.organizationName),
    intro: copy.intro(values.organizationName),
    lines: [],
    muted: [copy.change, copy.thanks],
  });
}

/** Which templates exist. A type absent here has no renderer and cannot be sent. */
export const RENDERABLE_TYPES: readonly NotificationType[] = [
  NotificationTypes.BOOKING_REQUESTED,
  NotificationTypes.BOOKING_CONFIRMATION,
  NotificationTypes.BOOKING_UPDATED,
  NotificationTypes.BOOKING_CANCELLED,
  NotificationTypes.BOOKING_REMINDER,
  NotificationTypes.ORGANIZATION_CREATED,
  NotificationTypes.PROVIDER_INVITED,
  NotificationTypes.SUBSCRIPTION_LINK,
  NotificationTypes.SUBSCRIPTION_CONFIRMED,
  NotificationTypes.TRIAL_ENDING_SOON,
  NotificationTypes.SUBSCRIPTION_PAYMENT_FAILED,
];

export function isRenderable(type: NotificationType): boolean {
  return RENDERABLE_TYPES.includes(type);
}
