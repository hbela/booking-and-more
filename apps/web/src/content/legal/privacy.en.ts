import type { LegalDocument } from "./types";

export const privacyEn: LegalDocument = {
  title: "Privacy notice",
  effective: "2026-11-01",
  intro: [
    "This notice explains how the operator of Booking and More, named in the legal notice at the bottom of this page (“we”), handles personal data. We act in two roles: as controller for the data of businesses that use the Service and their staff (sections 2 and 3), and as processor for the data of those businesses’ own clients, such as patients (section 4).",
    "If this English text and the Hungarian text differ, the Hungarian text prevails.",
  ],
  sections: [
    {
      id: "controller",
      heading: "1. Who we are",
      blocks: [
        "The controller is the operator named in the legal notice below. Requests about personal data can be sent to the email address shown there.",
      ],
    },
    {
      id: "staff",
      heading: "2. Owners, providers and assistants",
      blocks: [
        "Data: name, email address, a one-way hash of the password, sign-in sessions, the organizations and roles held, and a record of important changes made in the dashboard.",
        "Purpose and legal basis: providing the account and the Service under the contract (GDPR Art. 6(1)(b)), and keeping the Service secure (Art. 6(1)(f), our legitimate interest in preventing misuse).",
        "Retention: while the account exists. After the organization’s contract ends, as described in section 12 of the Terms of Service.",
      ],
    },
    {
      id: "billing",
      heading: "3. Billing",
      blocks: [
        "Data: the billing name, address and tax number given at payment, the subscription and its payment status, and the invoices issued.",
        "Card details are entered on Stripe’s payment page and are processed by Stripe only; we never receive them.",
        "Purpose and legal basis: performing the contract (Art. 6(1)(b)) and meeting accounting and tax obligations (Art. 6(1)(c)). Invoices are kept for 8 years, as the Hungarian Accounting Act (Section 169) requires.",
      ],
    },
    {
      id: "patients",
      heading: "4. Clients of the businesses (processing on their behalf)",
      blocks: [
        "When someone books with a business through Booking and More, that business is the controller of their data, and its own privacy notice applies. We process the data on the business’s behalf and only on its instructions, to provide the Service. Requests concerning these data should be sent to the business; if one reaches us, we forward it.",
        "Data: name, email address, phone number, notes given with the booking, the bookings themselves, and, where the business uses the AI assistant, the chat messages.",
        "How we process them:",
        {
          list: [
            "Names and contact details are encrypted in the database.",
            "Booking emails are sent on the business’s behalf.",
            "Chat messages are redacted 90 days after the conversation.",
            "Only the business’s own staff can see its clients; other organizations cannot.",
            "We use the processors in section 5 and inform businesses before adding a new one.",
            "We help the business respond to its clients’ requests and to incidents, and delete or return the data when the contract ends, as described in the Terms of Service.",
          ],
        },
      ],
    },
    {
      id: "processors",
      heading: "5. Processors",
      blocks: [
        {
          list: [
            "Hetzner Online GmbH (Germany): hosting of the application and database.",
            "Cloudflare, Inc.: storage of encrypted backups.",
            "Stripe Payments Europe, Ltd. (Ireland): card payments and subscriptions.",
            "Billingo Technologies Zrt. (Hungary): invoicing and reporting invoices to NAV.",
            "Resend, Inc. (USA): sending emails.",
            "Functional Software, Inc. (Sentry), EU data region: error reports, with personal data removed before sending.",
            "Anthropic, PBC (USA): the AI chat assistant, for businesses on the Professional plans only.",
          ],
        },
        "Where data is transferred outside the European Economic Area, the transfer relies on the European Commission’s standard contractual clauses or the EU–US Data Privacy Framework, as applicable.",
      ],
    },
    {
      id: "cookies",
      heading: "6. Cookies",
      blocks: [
        "We use only cookies that the Service needs: the sign-in session, and the chosen language and colour theme. We use no advertising or analytics cookies.",
        "When an error occurs in the browser, an error report is sent to Sentry. It may include a recording of the screen in which all text, input and media are hidden.",
      ],
    },
    {
      id: "security",
      heading: "7. Security and backups",
      blocks: [
        "Connections are encrypted (HTTPS). Clients’ names and contact details are encrypted in the database. Backups are made every 30 minutes, encrypted, and stored off-site; they are kept for 7 days in full and as one daily copy for 30 days. If a backup is ever restored, deletions made after it was taken are applied again.",
      ],
    },
    {
      id: "rights",
      heading: "8. Your rights",
      blocks: [
        "You may request access to your data, its correction or erasure, restriction of its processing, and a copy in a portable format, and you may object to processing based on legitimate interest. We reply within one month.",
        "You may complain to the Hungarian National Authority for Data Protection and Freedom of Information (NAIH, 1055 Budapest, Falk Miksa utca 9–11, www.naih.hu) or go to court.",
      ],
    },
    {
      id: "incidents",
      heading: "9. Incidents",
      blocks: [
        "If a personal data breach occurs, we notify NAIH within 72 hours where the law requires, inform the businesses affected without undue delay, and inform the people affected where the breach is likely to put them at high risk.",
      ],
    },
    {
      id: "changes",
      heading: "10. Changes",
      blocks: [
        "We publish changes to this notice on this page and notify subscribing businesses by email.",
      ],
    },
  ],
};
