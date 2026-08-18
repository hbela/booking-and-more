import { describe, expect, it } from "vitest";

import { buildGoogleCalendarUrl } from "./calendar.js";
import {
  escapeHtml,
  isRenderable,
  renderBookingCancelled,
  renderBookingConfirmation,
  renderBookingReminder,
  renderBookingRequested,
  renderBookingUpdated,
  renderCalendarDisconnected,
  renderOrganizationCreated,
  renderAssistantInvited,
  renderProviderInvited,
  renderSubscriptionConfirmed,
  delegationScopeLabel,
} from "./templates.js";
import { NotificationTypes, type NotificationType } from "./types.js";

const values = {
  organizationName: "Wellness Kft",
  ownerName: "Kovács Anna",
  acceptUrl: "http://localhost:3000/invitations/abc123",
  expiresAt: "2026-08-05 10:00",
};

describe("escapeHtml", () => {
  it("escapes the characters that break markup", () => {
    expect(escapeHtml(`<script>"x" & 'y'`)).toBe("&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;");
  });

  it("leaves ordinary text alone, accents included", () => {
    expect(escapeHtml("Kovács Anna")).toBe("Kovács Anna");
  });
});

describe("renderOrganizationCreated", () => {
  it.each(["hu", "en"] as const)("renders %s with a subject, html and text", (locale) => {
    const email = renderOrganizationCreated(locale, values);

    expect(email.subject).toContain("Wellness Kft");
    expect(email.html).toContain("http://localhost:3000/invitations/abc123");
    expect(email.text).toContain("http://localhost:3000/invitations/abc123");
  });

  it("always produces a text part", () => {
    // An HTML-only email scores worse with spam filters, and a provisioning
    // link in the spam folder is a customer who never onboards.
    const email = renderOrganizationCreated("en", values);

    expect(email.text.length).toBeGreaterThan(50);
    expect(email.text).not.toContain("<");
  });

  it("differs by locale", () => {
    const hu = renderOrganizationCreated("hu", values);
    const en = renderOrganizationCreated("en", values);

    expect(hu.subject).not.toBe(en.subject);
    expect(hu.text).not.toBe(en.text);
  });

  it("says no password is coming", () => {
    // A customer expecting a password will otherwise write in asking where it
    // is — the predecessor emailed one, so the expectation is not hypothetical.
    expect(renderOrganizationCreated("en", values).text.toLowerCase()).toContain("password");
    expect(renderOrganizationCreated("hu", values).text.toLowerCase()).toContain("jelsz");
  });

  it("escapes an organization name containing markup", () => {
    const email = renderOrganizationCreated("en", {
      ...values,
      organizationName: `Smith & Sons <script>alert(1)</script>`,
    });

    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&amp;");
  });

  it("escapes an ampersand in the accept URL", () => {
    // Query strings arrive here eventually; an unescaped & truncates the href.
    const email = renderOrganizationCreated("en", {
      ...values,
      acceptUrl: "http://localhost:3000/invitations/abc?a=1&b=2",
    });

    expect(email.html).toContain("a=1&amp;b=2");
  });

  it("includes the expiry, because the link dies before the organization does", () => {
    const email = renderOrganizationCreated("en", values);
    expect(email.text).toContain("2026-08-05 10:00");
  });
});

describe("renderSubscriptionConfirmed", () => {
  const confirmed = {
    organizationName: "Wellness Kft",
    recipientName: "Kovács Anna",
    planName: "Starter",
    trial: true,
    renewsOn: "31 August 2026",
    dashboardUrl: "http://localhost:3000/dashboard",
  };

  it.each(["hu", "en"] as const)("renders %s with a subject, html and text", (locale) => {
    const email = renderSubscriptionConfirmed(locale, confirmed);

    expect(email.subject).toContain("Wellness Kft");
    expect(email.html).toContain("http://localhost:3000/dashboard");
    expect(email.text).toContain("http://localhost:3000/dashboard");
    expect(email.text).not.toContain("<");
  });

  /**
   * The line that prevents a dispute.
   *
   * A trial confirmation that does not name the date of the first charge is how
   * a customer ends up surprised by a bill they technically agreed to — the same
   * reasoning as the trial-ending email, applied at the moment they are actually
   * paying attention.
   */
  it("names the charge date and the escape hatch during a trial", () => {
    const en = renderSubscriptionConfirmed("en", confirmed);

    expect(en.text).toContain("31 August 2026");
    expect(en.text.toLowerCase()).toContain("cancel");

    const hu = renderSubscriptionConfirmed("hu", confirmed);
    expect(hu.text).toContain("31 August 2026");
    expect(hu.text.toLowerCase()).toContain("lemondhatja");
  });

  it("calls it a renewal, not a trial end, once they are paying", () => {
    const email = renderSubscriptionConfirmed("en", { ...confirmed, trial: false });

    expect(email.text).toContain("31 August 2026");
    // "your free trial ends" would be a lie to somebody who has been charged.
    expect(email.text.toLowerCase()).not.toContain("free trial");
  });

  it("drops the charge line rather than inventing a date", () => {
    // Stripe does not always give us one. A confirmation that says "you will be
    // charged on " is worse than one that says nothing about dates.
    const email = renderSubscriptionConfirmed("en", { ...confirmed, renewsOn: "" });

    expect(email.text).not.toContain("charge");
    expect(email.text).toContain("Wellness Kft");
  });

  it("escapes markup in the organization name", () => {
    const email = renderSubscriptionConfirmed("en", {
      ...confirmed,
      organizationName: `Smith & Sons <script>alert(1)</script>`,
    });

    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&amp;");
  });

  it("differs by locale", () => {
    expect(renderSubscriptionConfirmed("hu", confirmed).subject).not.toBe(
      renderSubscriptionConfirmed("en", confirmed).subject,
    );
  });
});

describe("renderProviderInvited", () => {
  const invited = {
    organizationName: "Wellness Kft",
    providerName: "Dr. Kovács Anna",
    invitedByName: "Nagy Béla",
    acceptUrl: "http://localhost:3000/en/invitations/abc123",
    expiresAt: "2026-08-11 10:00",
  };

  it.each(["hu", "en"] as const)("renders %s with a subject, html and text", (locale) => {
    const email = renderProviderInvited(locale, invited);

    // The subject names the organization, not the provider: the recipient *is*
    // the provider, and their own name in the subject line reads as spam.
    expect(email.subject).toContain("Wellness Kft");
    expect(email.subject).not.toContain("Kovács");
    expect(email.html).toContain(invited.acceptUrl);
    expect(email.text).toContain(invited.acceptUrl);
  });

  it("greets the provider and credits whoever invited them", () => {
    const email = renderProviderInvited("en", invited);

    expect(email.text).toContain("Dr. Kovács Anna");
    expect(email.text).toContain("Nagy Béla");
  });

  it("says no password is coming, in both parts", () => {
    // The HTML too, not only the text: most recipients never see the text part,
    // and this is the sentence that stops the "where is my password" support
    // request. The predecessor emailed one, so it is not hypothetical.
    const en = renderProviderInvited("en", invited);
    expect(en.text.toLowerCase()).toContain("password");
    expect(en.html.toLowerCase()).toContain("password");

    const hu = renderProviderInvited("hu", invited);
    expect(hu.text.toLowerCase()).toContain("jelsz");
    expect(hu.html.toLowerCase()).toContain("jelsz");
  });

  it("always produces a text part", () => {
    const email = renderProviderInvited("en", invited);

    expect(email.text.length).toBeGreaterThan(50);
    expect(email.text).not.toContain("<");
  });

  it("escapes an organization name a salesperson typed", () => {
    const email = renderProviderInvited("en", {
      ...invited,
      organizationName: `Smith & Sons <script>alert(1)</script>`,
    });

    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&amp;");
  });

  it("differs by locale", () => {
    expect(renderProviderInvited("hu", invited).subject).not.toBe(
      renderProviderInvited("en", invited).subject,
    );
  });

  it("does not promise the owner's screens", () => {
    // The organization email says "add your services, staff and opening hours",
    // which is exactly the three navigation items a PROVIDER does not have.
    const email = renderProviderInvited("en", invited).text.toLowerCase();

    expect(email).toContain("working hours");
    expect(email).not.toContain("staff");
  });
});

describe("renderCalendarDisconnected", () => {
  const disconnected = {
    organizationName: "Napfény Fogászat",
    recipientName: "Dr. Kovács Anna",
    accountEmail: "anna.personal@gmail.com",
    providerName: "Dr. Kovács Anna",
    reconnectUrl: "http://localhost:3000/dashboard/integrations",
  };

  it.each(["hu", "en"] as const)("renders %s with a subject, html and text", (locale) => {
    const email = renderCalendarDisconnected(locale, disconnected);

    expect(email.subject).toContain("Napfény Fogászat");
    expect(email.html).toContain(disconnected.reconnectUrl);
    expect(email.text).toContain(disconnected.reconnectUrl);
    expect(email.text).not.toContain("<");
  });

  /**
   * **The assertion this template exists for.**
   *
   * PRD §9.10's promise, said to the person worried about it: a calendar failure
   * never touches a booking. An email that reports the disconnection without it
   * reads as "your appointments may be gone", which is both false and the single
   * most alarming thing this product could say to a provider.
   */
  it("promises the bookings are safe, before it asks for anything", () => {
    const en = renderCalendarDisconnected("en", disconnected);

    expect(en.text).toContain("Your bookings are safe");
    // Before the call to action, not after it. Somebody who reads two lines and
    // stops must still have been reassured.
    expect(en.text.indexOf("Your bookings are safe")).toBeLessThan(en.text.indexOf("To reconnect"));

    const hu = renderCalendarDisconnected("hu", disconnected);
    expect(hu.text).toContain("biztonságban");
  });

  it("says what has actually stopped, so 'safe' does not read as 'nothing is wrong'", () => {
    const email = renderCalendarDisconnected("en", disconnected);

    expect(email.text.toLowerCase()).toContain("will not reach that calendar");
  });

  it("names the Google account, because a person may have several", () => {
    // The address Google reports, not the one they sign in to us with. Without
    // it, somebody with a work and a personal account cannot tell which broke.
    const email = renderCalendarDisconnected("en", disconnected);
    expect(email.text).toContain("anna.personal@gmail.com");
  });

  it("explains why it happened rather than implying our software broke", () => {
    const email = renderCalendarDisconnected("en", disconnected);
    expect(email.text.toLowerCase()).toContain("withdrawn");
  });

  it("drops the diary line rather than leaving a gap", () => {
    const email = renderCalendarDisconnected("en", { ...disconnected, providerName: null });

    expect(email.text).not.toContain("diary");
    expect(email.text).toContain("Your bookings are safe");
  });

  it("escapes markup in the account address", () => {
    const email = renderCalendarDisconnected("en", {
      ...disconnected,
      accountEmail: `a&b<script>alert(1)</script>@gmail.com`,
    });

    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&amp;");
  });

  it("differs by locale", () => {
    expect(renderCalendarDisconnected("hu", disconnected).subject).not.toBe(
      renderCalendarDisconnected("en", disconnected).subject,
    );
  });
});

describe("isRenderable", () => {
  it("knows the templates that exist", () => {
    expect(isRenderable(NotificationTypes.ORGANIZATION_CREATED)).toBe(true);
    expect(isRenderable(NotificationTypes.PROVIDER_INVITED)).toBe(true);
    expect(isRenderable(NotificationTypes.ASSISTANT_INVITED)).toBe(true);
    expect(isRenderable(NotificationTypes.BOOKING_CONFIRMATION)).toBe(true);
    expect(isRenderable(NotificationTypes.BOOKING_REQUESTED)).toBe(true);
    expect(isRenderable(NotificationTypes.BOOKING_REMINDER)).toBe(true);
  });

  it("now has every type in the enum, including the last one to arrive", () => {
    // This assertion used to read `.toBe(false)` — "the last one left:
    // staff-facing, and it arrives with Google Calendar". It has arrived
    // (docs/phase-6-google-calendar-part-1.md §6), so what it asserts is
    // inverted rather than the test being deleted: the point it was making is
    // that `isRenderable` is the gate a type must pass to be sent at all, and
    // that point still needs a test.
    expect(isRenderable(NotificationTypes.CALENDAR_DISCONNECTED)).toBe(true);

    // The gate itself, proved with a type that does not exist. Without this the
    // suite would no longer show that `isRenderable` can say no.
    expect(isRenderable("NOT_A_REAL_TYPE" as NotificationType)).toBe(false);
  });
});

// --- Bookings --------------------------------------------------------------

const booking = {
  organizationName: "Napfény Fogászat",
  customerName: "Nagy Béla",
  serviceName: "Fogtisztítás",
  providerName: "Dr. Kiss Anna",
  when: "2026. augusztus 12., szerda 10:00",
  locationName: "Belváros",
  locationAddress: "Fő utca 1., Budapest",
  price: "15 000 Ft",
  reference: "BK-4C7A",
};

const MANAGE_URL = "http://localhost:3000/en/booking/manage/tok123";

/** The same appointment, in the shape the calendar builder wants. */
const calendarEvent = {
  organizationName: booking.organizationName,
  serviceName: booking.serviceName,
  providerName: booking.providerName,
  locationName: booking.locationName,
  locationAddress: booking.locationAddress,
  reference: booking.reference,
  startAt: new Date("2026-08-12T08:00:00.000Z"),
  endAt: new Date("2026-08-12T08:45:00.000Z"),
};

describe("booking emails", () => {
  it.each(["hu", "en"] as const)("render %s with the appointment's own facts", (locale) => {
    const email = renderBookingConfirmation(locale, {
      ...booking,
      manageUrl: MANAGE_URL,
      cancellationPolicy: null,
      addToCalendarUrl: null,
    });

    for (const part of [email.text, email.html]) {
      expect(part).toContain("Dr. Kiss Anna");
      expect(part).toContain("Fogtisztítás");
      expect(part).toContain("BK-4C7A");
      expect(part).toContain("15 000 Ft");
    }
  });

  it("always produces a text part with no markup in it", () => {
    const email = renderBookingReminder("hu", booking);

    expect(email.text.length).toBeGreaterThan(50);
    expect(email.text).not.toContain("<");
  });

  it("differs by locale", () => {
    const hu = renderBookingCancelled("hu", { ...booking, bookingUrl: null });
    const en = renderBookingCancelled("en", { ...booking, bookingUrl: null });

    expect(hu.subject).not.toBe(en.subject);
    expect(hu.text).not.toBe(en.text);
  });

  it("escapes a clinic whose name is markup", () => {
    // "Smith & Sons" is a broken email long before anyone tries anything
    // malicious, and a booking's values come from forms typed by customers.
    const email = renderBookingReminder("en", {
      ...booking,
      organizationName: "Smith & Sons",
      customerName: "<script>alert(1)</script>",
    });

    expect(email.html).toContain("Smith &amp; Sons");
    expect(email.html).not.toContain("<script>");
    expect(email.text).toContain("Smith & Sons");
  });

  it("drops the place line when the booking names no location", () => {
    // A single-site clinic records neither, and an empty "Where:" reads as
    // missing information rather than as a clinic with one address.
    const email = renderBookingReminder("en", {
      ...booking,
      locationName: null,
      locationAddress: null,
    });

    expect(email.text).not.toContain("Where");
    expect(email.text).toContain("With");
  });

  it("drops the price line when the booking records no price", () => {
    const email = renderBookingReminder("en", { ...booking, price: null });

    expect(email.text).not.toContain("Price");
  });
});

describe("renderBookingRequested", () => {
  it("says out loud that this is not a confirmation yet", () => {
    // The whole reason the template exists. A customer who reads it as a
    // confirmation turns up to an appointment nobody accepted.
    const en = renderBookingRequested("en", { ...booking, manageUrl: MANAGE_URL });
    const hu = renderBookingRequested("hu", { ...booking, manageUrl: MANAGE_URL });

    expect(en.text.toLowerCase()).toContain("not a confirmed appointment yet");
    expect(hu.text).toContain("még nem végleges");
  });

  it("carries the manage link in both parts", () => {
    const email = renderBookingRequested("en", { ...booking, manageUrl: MANAGE_URL });

    expect(email.text).toContain(MANAGE_URL);
    expect(email.html).toContain(MANAGE_URL);
  });
});

describe("renderBookingConfirmation", () => {
  it("offers the manage link when the event carried a token", () => {
    const email = renderBookingConfirmation("en", {
      ...booking,
      manageUrl: MANAGE_URL,
      cancellationPolicy: null,
      addToCalendarUrl: null,
    });

    expect(email.text).toContain(MANAGE_URL);
    expect(email.text).not.toContain("the email you received when you booked");
  });

  it("points at the earlier email instead when staff accepted a request", () => {
    // No raw token exists on that path, and a button that links nowhere is
    // worse than a sentence saying where the link is.
    const email = renderBookingConfirmation("en", {
      ...booking,
      manageUrl: null,
      cancellationPolicy: null,
      addToCalendarUrl: null,
    });

    expect(email.text).not.toContain(MANAGE_URL);
    expect(email.text).not.toContain("http");
    expect(email.text).toContain("the email you received when you booked");
  });

  it("prints the cancellation policy as the clinic wrote it", () => {
    // Free text, and nothing derives a number of minutes from it — phase-4 §5.1.
    const email = renderBookingConfirmation("hu", {
      ...booking,
      manageUrl: MANAGE_URL,
      cancellationPolicy: "24 órán belüli lemondás esetén a díj 50%-át felszámítjuk.",
      addToCalendarUrl: null,
    });

    expect(email.text).toContain("24 órán belüli lemondás");
  });

  it("carries the calendar link in both parts, in the reader's language", () => {
    const url = buildGoogleCalendarUrl("en", calendarEvent) as string;

    const email = renderBookingConfirmation("en", {
      ...booking,
      manageUrl: MANAGE_URL,
      cancellationPolicy: null,
      addToCalendarUrl: url,
    });

    expect(email.text).toContain(url);
    expect(email.text).toContain("Add to Google Calendar");

    // The href must survive HTML-escaping with its separators intact, or Google
    // receives one parameter named `action` and nothing else.
    expect(email.html).toContain(`href="${escapeHtml(url)}"`);
    expect(email.html).toContain("&amp;dates=");

    const hu = renderBookingConfirmation("hu", {
      ...booking,
      manageUrl: MANAGE_URL,
      cancellationPolicy: null,
      addToCalendarUrl: url,
    });

    expect(hu.text).toContain("Hozzáadás a Google Naptárhoz");
  });

  it("offers the calendar link even when there is no manage link", () => {
    // The two are independent: the calendar URL carries no token, so it is
    // available on the staff-accepted path where the manage link is not.
    const url = buildGoogleCalendarUrl("en", calendarEvent) as string;

    const email = renderBookingConfirmation("en", {
      ...booking,
      manageUrl: null,
      cancellationPolicy: null,
      addToCalendarUrl: url,
    });

    expect(email.text).toContain(url);
    expect(email.text).not.toContain(MANAGE_URL);
    // Still says where to find the manage link, since it has no button for it.
    expect(email.text).toContain("the email you received when you booked");
  });

  it("is the only booking email that offers it", () => {
    // A request is explicitly not booked yet; a cancellation and a reminder are
    // not things to save. None of them accepts the value at all, which is the
    // structural version of this assertion — this one guards the text.
    for (const email of [
      renderBookingRequested("en", { ...booking, manageUrl: MANAGE_URL }),
      renderBookingCancelled("en", { ...booking, bookingUrl: null }),
      renderBookingReminder("en", booking),
      renderBookingUpdated("en", { ...booking, previousWhen: null }),
    ]) {
      expect(email.text).not.toContain("calendar.google.com");
    }
  });
});

describe("renderBookingUpdated", () => {
  it("names where the appointment used to be", () => {
    const email = renderBookingUpdated("en", {
      ...booking,
      previousWhen: "Tuesday 11 August 2026 at 09:00",
    });

    expect(email.text).toContain("Tuesday 11 August 2026 at 09:00");
  });

  it("drops that line rather than guessing when the event did not record it", () => {
    const email = renderBookingUpdated("en", { ...booking, previousWhen: null });

    expect(email.text).not.toContain("previously");
    // Still identifiable: the details block names the booking by reference.
    expect(email.text).toContain("BK-4C7A");
  });

  it("carries no link of its own", () => {
    // A staff reschedule has no token, so a button here would appear only when
    // the customer moved the booking — an inconsistency nobody could account
    // for (docs/phase-5-booking-notifications.md §2.1).
    const email = renderBookingUpdated("en", { ...booking, previousWhen: null });

    expect(email.text).not.toContain("http");
    expect(email.text).toContain("still works");
  });
});

describe("renderBookingCancelled", () => {
  it("offers the public booking page, which is not a credential", () => {
    const email = renderBookingCancelled("en", {
      ...booking,
      bookingUrl: "http://localhost:3000/en/napfeny/book",
    });

    expect(email.text).toContain("http://localhost:3000/en/napfeny/book");
  });
});

describe("renderBookingReminder", () => {
  it("carries no link at all", () => {
    // Its row is written when the booking is made and sent days later, so a
    // manage URL would sit in the database for the whole booking horizon —
    // the exposure phase-4 §4's hash-only safeguard exists to prevent (§2.2).
    const email = renderBookingReminder("en", booking);

    expect(email.text).not.toContain("http");
    expect(email.html).not.toContain("href");
  });

  it("says where the customer can find one", () => {
    expect(renderBookingReminder("en", booking).text).toContain(
      "the email you received when you booked",
    );
    expect(renderBookingReminder("hu", booking).text).toContain("foglaláskor kapott levélben");
  });
});

describe("renderAssistantInvited", () => {
  const invited = {
    organizationName: "Wellness Kft",
    providerName: "Dr. Kovács Anna",
    invitedByName: "Nagy Béla",
    scopes: ["seeing and managing bookings"],
    acceptUrl: "http://localhost:3000/en/invitations/abc123",
    expiresAt: "2026-08-11 10:00",
  };

  it.each(["hu", "en"] as const)("renders %s with a subject, html and text", (locale) => {
    const email = renderAssistantInvited(locale, invited);

    expect(email.subject).toContain("Wellness Kft");
    expect(email.html).toContain(invited.acceptUrl);
    expect(email.text).toContain(invited.acceptUrl);
  });

  it("names the provider they are being asked to assist", () => {
    // The one fact that makes this email answerable. Without it the recipient
    // is being handed somebody's diary and not told whose.
    const email = renderAssistantInvited("en", invited);

    expect(email.text).toContain("Dr. Kovács Anna");
    expect(email.html).toContain("Dr. Kovács Anna");
  });

  it("never greets the recipient as the provider", () => {
    // The mistake a shared template with renderProviderInvited would make, and
    // the reason the two are separate functions. This recipient is *not* the
    // provider named in the body.
    const email = renderAssistantInvited("en", invited);

    expect(email.text.startsWith("Dear Dr. Kovács Anna")).toBe(false);
    expect(email.subject).not.toContain("Kovács");
  });

  it("lists what the invitation covers, in both parts", () => {
    const email = renderAssistantInvited("en", {
      ...invited,
      scopes: ["setting working hours and time off", "seeing and managing bookings"],
    });

    for (const part of [email.text, email.html]) {
      expect(part).toContain("setting working hours and time off");
      expect(part).toContain("seeing and managing bookings");
    }
  });

  it("credits whoever invited them", () => {
    expect(renderAssistantInvited("en", invited).text).toContain("Nagy Béla");
  });

  it("says no password is coming, in both parts", () => {
    const email = renderAssistantInvited("en", invited);

    expect(email.text).toMatch(/never email passwords/iu);
    expect(email.html).toMatch(/never email passwords/iu);
  });

  it("escapes a provider name that contains markup", () => {
    const email = renderAssistantInvited("en", {
      ...invited,
      providerName: '<script>alert("x")</script>',
    });

    expect(email.html).not.toContain("<script>");
  });
});

describe("delegationScopeLabel", () => {
  it("names both scopes in both locales", () => {
    for (const locale of ["hu", "en"] as const) {
      for (const scope of ["AVAILABILITY", "BOOKINGS"]) {
        const label = delegationScopeLabel(locale, scope);
        expect(label).toBeTruthy();
        // Not the raw enum value: this is what a recipient reads.
        expect(label).not.toBe(scope);
      }
    }
  });

  it("falls back to the raw value rather than throwing", () => {
    // A database enum newer than this build must degrade, not 500 the sender.
    expect(delegationScopeLabel("en", "BILLING_SOMEDAY")).toBe("BILLING_SOMEDAY");
  });
});
