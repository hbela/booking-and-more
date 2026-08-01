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

/** Which templates exist. A type absent here has no renderer and cannot be sent. */
export const RENDERABLE_TYPES: readonly NotificationType[] = [
  NotificationTypes.ORGANIZATION_CREATED,
  NotificationTypes.SUBSCRIPTION_LINK,
  NotificationTypes.TRIAL_ENDING_SOON,
  NotificationTypes.SUBSCRIPTION_PAYMENT_FAILED,
];

export function isRenderable(type: NotificationType): boolean {
  return RENDERABLE_TYPES.includes(type);
}
