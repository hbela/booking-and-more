import type { LegalDocument } from "./types";

export const refundEn: LegalDocument = {
  title: "Cancellation and refunds",
  effective: "2026-11-01",
  intro: [
    "This page explains how to cancel a Booking and More subscription and when a payment is refunded. It is part of the Terms of Service. If this English text and the Hungarian text differ, the Hungarian text prevails.",
  ],
  sections: [
    {
      id: "cancel",
      heading: "1. Cancelling",
      blocks: [
        "The owner can cancel at any time from the dashboard: Subscription, then Manage billing. The cancellation takes effect at the end of the current paid period. The Service stays available until then, and nothing further is charged.",
      ],
    },
    {
      id: "trial",
      heading: "2. During the free trial",
      blocks: ["If the subscription is cancelled before the free trial ends, nothing is charged."],
    },
    {
      id: "refunds",
      heading: "3. Refunds",
      blocks: [
        "Monthly fees are not refunded for the part of a period left after a cancellation or a downgrade. We refund:",
        {
          list: [
            "a payment taken in error, such as a duplicate charge or a charge after the cancellation took effect, in full;",
            "a proportional part of the monthly fee, on request, if the Service was unavailable for a substantial part of the period for reasons on our side;",
            "any other payment where the law requires it.",
          ],
        },
      ],
    },
    {
      id: "how",
      heading: "4. How to ask for a refund",
      blocks: [
        "Write to the email address in the legal notice below within 30 days of the charge, naming the organization and the invoice. An approved refund goes back to the card that paid, through Stripe; banks usually show it within 5–10 business days. We issue a corrective invoice for it.",
      ],
    },
    {
      id: "plan-changes",
      heading: "5. Changing plan",
      blocks: [
        "An upgrade is charged pro rata for the rest of the period. A downgrade takes effect at the end of the period, and the difference is not refunded.",
      ],
    },
    {
      id: "assisted-setup",
      heading: "6. Assisted configuration",
      blocks: [
        "The one-time assisted configuration fee is refunded in full if it is cancelled before the work starts. Once the configuration has been delivered, it is not refunded.",
      ],
    },
    {
      id: "consumers",
      heading: "7. Right of withdrawal",
      blocks: [
        "The Service is offered to businesses only. The consumer right of withdrawal under Government Decree 45/2014 therefore does not apply.",
      ],
    },
  ],
};
