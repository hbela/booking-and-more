import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  isRenderable,
  renderOrganizationCreated,
  renderSubscriptionConfirmed,
} from "./templates.js";
import { NotificationTypes } from "./types.js";

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

describe("isRenderable", () => {
  it("knows the templates that exist", () => {
    expect(isRenderable(NotificationTypes.ORGANIZATION_CREATED)).toBe(true);
  });

  it("refuses a type with no template rather than sending an empty email", () => {
    expect(isRenderable(NotificationTypes.BOOKING_CONFIRMATION)).toBe(false);
  });
});
