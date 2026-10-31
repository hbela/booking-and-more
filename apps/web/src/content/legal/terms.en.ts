import type { LegalDocument } from "./types";

export const termsEn: LegalDocument = {
  title: "Terms of Service",
  effective: "2026-11-01",
  intro: [
    "These terms govern the Booking and More online appointment-booking service (the “Service”) between the operator named in the legal notice at the bottom of this page (“we”, “us”) and the business that creates an account and subscribes (the “Customer”).",
    "If this English text and the Hungarian text differ, the Hungarian text prevails.",
  ],
  sections: [
    {
      id: "scope",
      heading: "1. Who the Service is for",
      blocks: [
        "The Service is offered to businesses: clinics, practices and other service providers that take appointments. It is not offered to consumers. Whoever creates an owner account and subscribes does so on behalf of the business and confirms they are entitled to bind it.",
        "The Customer’s own clients (for example patients) use the public booking pages free of charge. They do not enter into a contract with us; their relationship is with the Customer.",
      ],
    },
    {
      id: "service",
      heading: "2. The Service",
      blocks: [
        "The Service provides a public booking page for each organization, a dashboard for managing services, providers, locations, working hours and bookings, a staff app that can be installed on a phone, and booking confirmation, change and reminder emails.",
        "The Professional and Professional Plus plans also include an AI chat assistant that can answer questions and book appointments, within the monthly and daily chat limits shown on the Pricing page.",
        "We may improve and change the Service. We will not remove a core feature of a plan during a period the Customer has already paid for.",
      ],
    },
    {
      id: "account",
      heading: "3. Accounts",
      blocks: [
        "The owner account manages the organization and may invite providers and assistants. The Customer is responsible for the people it invites, for keeping passwords confidential, and for the accuracy of the information it enters.",
        "One subscription covers one organization.",
      ],
    },
    {
      id: "prices",
      heading: "4. Prices and payment",
      blocks: [
        "The prices of the plans are shown on the Pricing page in Hungarian forints per month. We are subject to the Hungarian VAT subject exemption (alanyi adómentesség), so no VAT is charged.",
        "Fees are paid monthly in advance by card through Stripe. Card details are entered on Stripe’s payment page and never reach us. After each successful payment we issue an electronic invoice through Billingo, which reports it to the Hungarian tax authority (NAV).",
        "Assisted configuration is an optional one-time service at the price shown on the Pricing page, agreed separately before work starts.",
      ],
    },
    {
      id: "trial",
      heading: "5. Free trial",
      blocks: [
        "Each organization may use one free trial of the length shown when subscribing. The card is registered at the start of the trial, and nothing is charged until the trial ends. If the Customer cancels before the trial ends, nothing is charged.",
      ],
    },
    {
      id: "changes",
      heading: "6. Changing plan and cancelling",
      blocks: [
        "The Customer manages the subscription from the Subscription screen of the dashboard, through Stripe’s customer portal:",
        {
          list: [
            "An upgrade takes effect immediately. The difference for the rest of the current period is charged pro rata.",
            "A downgrade takes effect at the end of the current period.",
            "A cancellation takes effect at the end of the current paid period. The Service remains available until then, and nothing further is charged.",
          ],
        },
        "Refunds are governed by the Cancellation and refunds page.",
      ],
    },
    {
      id: "failed-payments",
      heading: "7. Failed payments",
      blocks: [
        "If a payment fails, Stripe retries it over the following days and the Service remains available meanwhile. If the payment does not succeed, the subscription ends and the organization is suspended: its booking pages stop accepting bookings and its staff can no longer make changes. Its data is kept as described in section 12.",
      ],
    },
    {
      id: "data",
      heading: "8. The Customer’s data and its clients’ data",
      blocks: [
        "For the personal data of the Customer’s clients (names, contact details, bookings, messages) the Customer is the controller and we are its processor. The processing terms in section 4 of our Privacy notice form part of these terms.",
        "The Customer is responsible for having a lawful basis for the data it collects, for informing its clients, and for not entering more data than its bookings need.",
      ],
    },
    {
      id: "acceptable-use",
      heading: "9. Acceptable use",
      blocks: [
        "The Customer may not use the Service for unlawful purposes, to send unsolicited messages, to publish misleading information, or to attempt to access other organizations’ data or to overload the Service.",
      ],
    },
    {
      id: "availability",
      heading: "10. Availability",
      blocks: [
        "We aim to keep the Service available continuously, monitor it, and back up its data every 30 minutes to an encrypted off-site store. We do not guarantee uninterrupted operation. Planned maintenance is announced in advance by email where possible.",
      ],
    },
    {
      id: "liability",
      heading: "11. Liability",
      blocks: [
        "To the extent the law permits, our liability for any damage arising from the Service is limited to the fees the Customer paid in the three months before the event causing the damage. This limit does not apply to damage caused intentionally or by gross negligence, or to damage to life, physical integrity or health.",
        "We are not liable for the content the Customer publishes, for decisions it makes based on the AI assistant’s answers, or for interruptions caused by events outside our reasonable control.",
      ],
    },
    {
      id: "termination",
      heading: "12. Ending the contract",
      blocks: [
        "The contract ends when a cancellation takes effect, when a subscription ends for non-payment, or when we terminate it for a serious breach of these terms, after notice by email.",
        "Within 30 days after the contract ends, the Customer may ask by email for a copy of its clients’ data in a machine-readable format. After that period the organization’s data is deleted. Invoices are kept for the period required by accounting law, and backups expire within 37 days.",
      ],
    },
    {
      id: "amendments",
      heading: "13. Changes to these terms",
      blocks: [
        "We notify Customers of changes to these terms by email at least 15 days before they take effect. A Customer who does not accept the change may cancel before then; continued use after that date means acceptance.",
      ],
    },
    {
      id: "law",
      heading: "14. Governing law",
      blocks: [
        "These terms are governed by Hungarian law. Disputes are decided by the competent Hungarian court.",
      ],
    },
    {
      id: "contact",
      heading: "15. Contact",
      blocks: [
        "Questions about these terms can be sent to the email address in the legal notice below.",
      ],
    },
  ],
};
