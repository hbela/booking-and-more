# Organization QR codes and staff app

Patient QR codes open the organization's booking or chat page directly. Patients do not install an app. Staff retain their separate installation QR and existing sign-in flow.

## Subscription options

The dashboard's **Patient QR codes** section provides SVG downloads in the current language:

| Subscription | Patient QR codes                     |
| ------------ | ------------------------------------ |
| Starter      | Booking (`/book`)                    |
| Professional | Booking (`/book`) and Chat (`/chat`) |

Chat uses the existing live assistant entitlement, including Professional trials and entitled internal organizations. It is independent of temporary AI quota exhaustion or the assistant's enabled setting; the chat page continues to handle those conditions. A downgrade removes the chat download and prevents new chat QR generation. Already printed codes cannot be revoked, so the chat API continues enforcing access on every request.

The public catalogue exposes only `features.assistant`, not subscription or billing details. The chat QR endpoint checks this flag server-side and returns 404 when not entitled, or 503 when the lookup fails. A client-supplied plan cannot enable chat.

## Website links

Replace `wellness-demo` with the organization's slug. Do not put login tokens or patient data in QR URLs.

```html
<a href="https://app.booking.appointer.hu/wellness-demo/book">
  <img
    width="256"
    height="256"
    alt="Book an appointment"
    src="https://app.booking.appointer.hu/api/pwa/wellness-demo/book/qr?locale=hu"
  />
  Book an appointment — no installation needed
</a>
<!-- Show this card only when the chat QR is available for the subscription. -->
<a href="https://app.booking.appointer.hu/wellness-demo/chat">
  <img
    width="256"
    height="256"
    alt="Chat booking"
    src="https://app.booking.appointer.hu/api/pwa/wellness-demo/chat/qr?locale=hu"
  />
  Chat booking — no installation needed
</a>
<a href="https://app.booking.appointer.hu/wellness-demo/install/staff">
  <img
    width="256"
    height="256"
    alt="Install the staff app"
    src="https://app.booking.appointer.hu/api/pwa/wellness-demo/staff/qr?locale=hu"
  />
  Staff app — open installation
</a>
```

For English, prefix page links with `/en` and use `locale=en` on QR images. Preserve the white margin and display codes at least 192 pixels wide. Allow the application origin in the website's image CSP.

Wellness Demo includes both languages. Its `patient-qr.js` reveals chat links only after the entitlement-checked QR image loads; failures leave chat hidden. Include that script and the `[hidden]` CSS rule when reusing the example.

## Compatibility

The legacy `/api/pwa/{slug}/patient/qr` now encodes `/book`. Old printed codes pointing to `/{slug}/install/patient` redirect to `/book`, preserving the URL's language. Existing patient manifests remain available for previously installed apps, but no patient installation is offered by these QR flows.

Staff installations keep their existing manifest IDs, sign-in routes and permissions. Installation grants no access. Android may open same-origin links inside an already installed staff app; patient pages still open directly without requiring another installation. Internet access remains required.

## Deployment and verification

Deploy the **API**, **web app**, and **organization website**. Deploy the API first so the public entitlement flag is available; chat QR generation fails closed against an older API. No database migration or new environment variables are required. Keep the web service's existing `APP_BASE_URL` set to the public HTTPS origin and `NEXT_PUBLIC_API_BASE_URL` pointing at the API.

Verify Starter shows only booking, Professional shows booking and chat, and staff installation remains available. Scan both newly generated and old printed patient codes on Android and iPhone: they should open the relevant page directly. See [staff PWA](staff-pwa.md) for staff installation, worker updates and cache policy.
