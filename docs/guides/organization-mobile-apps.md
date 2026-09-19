# Organization website mobile apps

Each organization places two linked QR images on **its own website**: Patient app and Staff app. There is no organization picker on the Booking and More homepage. Wellness Demo's Hungarian and English websites include these cards as the working example.

Scanning on another screen, or tapping a card on the phone, opens an installation page with the organization's public name. Installation requires browser confirmation; a QR code cannot silently install an app. The page offers a native prompt when available, Android and iPhone/iPad instructions, and a continue-without-installing link. Open links in the system browser if a QR scanner or social app uses an embedded browser.

Installation pages keep the installation guide available even when opened inside an installed app. Standalone display mode does not identify which organization or audience was installed. If the patient QR opens inside the staff app, copy the QR link into Chrome on Android or Safari on iPhone/iPad before installing. On Android, restart an installation test by opening Settings > Apps > See all apps, selecting the installed staff web app, and choosing Uninstall. Then reopen the patient QR link in Chrome; use its installation menu if no native prompt appears.

## Add cards to another organization's website

Replace `wellness-demo` with the organization's configured **slug**, and the app origin if hosting elsewhere. The organization's website domain can differ from the application origin. No login token, patient identifier, or secret belongs in these URLs.

```html
<a href="https://app.booking.appointer.hu/wellness-demo/install/patient">
  <img
    width="256"
    height="256"
    alt="Install Wellness Demo patient app"
    src="https://app.booking.appointer.hu/api/pwa/wellness-demo/patient/qr?locale=hu"
  />
  Patient app — scan or tap to open installation
</a>
<a href="https://app.booking.appointer.hu/wellness-demo/install/staff">
  <img
    width="256"
    height="256"
    alt="Install Wellness Demo staff app"
    src="https://app.booking.appointer.hu/api/pwa/wellness-demo/staff/qr?locale=hu"
  />
  Staff app — scan or tap to open installation
</a>
```

For English, prefix installation links with `/en` and use `locale=en` on QR images. Preserve the white margin and render the QR at least 192 pixels wide. Allow the application origin in the website's image CSP if it has one. Explain beside the cards that the phone asks for confirmation and that Safari uses Share → Add to Home Screen.

## Launch and access

Patient apps launch the organization's existing booking page. Staff apps launch its sign-in route, which uses the existing organization membership check and activation flow before opening the dashboard. Owners, providers, and assistants keep their existing permissions. A QR link grants no access. Sessions, language, and theme still use the existing same-origin storage; separate app IDs do not isolate cookies or accounts.

Manifests use stable organization IDs plus audience, with localized organization/role names and existing calendar-plus icons. Changing language or organization slug does not change the app ID. Root scope accommodates shared dashboard and locale paths. Browsers differ in how they handle multiple installed apps with overlapping scopes; simultaneous staff/patient or multiple-organization installations need device verification. The generic Booking and More staff installation remains available.

Internet access is required for booking and business operations. The existing worker caches only static staff offline pages and their assets. Patient booking/chat and APIs remain network-only; installation adds no offline appointment access.

## Deployment and verification

Deploy the web application and the changed organization website. Set the web service's `APP_BASE_URL` to its public HTTPS origin so QR images behind Coolify encode the public address. Both Compose configurations now pass this existing setting to web. The manifest route also needs the existing `NEXT_PUBLIC_API_BASE_URL` to reach public organization branding. Organizations unavailable in the public catalogue cannot create a new installation through these pages.

Check each live QR with a phone camera, then inspect the confirmation name, home-screen icon, launch destination, and staff membership enforcement. Test Android Chrome, iPhone/iPad Safari, and desktop Chrome/Edge. Browser tests simulate prompt events and verify page routing/layout; they do not confirm OS installation. Physical-device installation and overlapping-scope behavior remain manual checks.

See [staff PWA](staff-pwa.md) for worker updates, cache policy, and rollback. To withdraw organization installation, remove its website cards and installation endpoints; already-installed home-screen apps require user removal. Do not change existing app IDs during an ordinary update.
