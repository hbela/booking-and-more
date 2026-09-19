# Booking and More staff PWA

One installation per web origin opens `/dashboard` and uses the existing staff session, language preference, active organization, and permissions. Install from the home page or dashboard's **Install app** control, including before sign-in. The home page explains owner account creation, staff invitations, and patient booking links, and shows Android and iPhone/iPad instructions. Supporting browsers offer their native prompt; other browsers show instructions, including Safari's Add to Home Screen. Standalone mode hides the control.

Organization-specific staff installation and direct patient booking/chat QR codes are described in [organization QR codes](organization-mobile-apps.md). The generic installation described here remains available. Push notifications, offline appointments, queued writes, and background synchronization are not included. A root manifest scope accommodates Hungarian and English staff paths; it is not an authorization boundary. Installation never grants permissions or extends a session's expiry.

## Offline behavior

The production-only registration runs on the home page, organization installation pages, dashboard and sign-in paths, including tenant/domain sign-in. HTTPS is required outside localhost. `/sw.js` has root scope but intercepts only staff document navigation and an exact allowlist of offline assets. Public booking/chat, management links, APIs, non-GET requests, and Next.js data requests pass through without caching or fallback substitution.

The `bam-staff-offline-v1` cache contains exactly:

- `/pwa/offline-en.html`
- `/pwa/offline-hu.html`
- `/pwa/offline.css`
- `/booking-and-more-mark.svg`

Staff documents are fetched from the network with `cache: no-store`; a network rejection returns the locale-specific offline page. HTTP errors retain their original response. English-prefixed requests receive English; other staff paths receive Hungarian. A worker must first install successfully online before it can handle an offline launch.

An already-open staff screen hides and makes its existing content inert on the browser's offline event, keeping unsaved inputs mounted in memory. Reconnection restores it; **Try again** reloads the current URL and discards unsaved inputs. The browser's connectivity signal does not prove that the API is healthy; ordinary API errors still use the existing error handling. No customer data is persisted by this feature.

## Assets and deployment

Run `corepack pnpm --filter @bam/web pwa:icons` to regenerate the committed PNGs from `booking-and-more-mark.svg`. Sharp is a development dependency. The maskable mark fits inside the central safe region. Existing Docker instructions already copy the manifest, worker, offline pages, and icons through `public/`.

Build and deploy the feature using the existing Coolify web service. No database migration, backend configuration, or new secrets are needed. Verify HTTPS, `/manifest.webmanifest`, `/sw.js`, and `/pwa/` asset responses. The worker is served with revalidation headers, a JavaScript MIME type, and a restrictive CSP. Document CSP explicitly allows same-origin workers without weakening script nonces.

## Updates and rollback

Increment `CACHE_NAME` in `public/sw.js` whenever offline assets change. The new worker installs its complete fallback cache before activation. It waits naturally until existing controlled tabs/windows close; it does not call `skipWaiting`, force reload, or take over a running form. Activation deletes only older `bam-staff-offline-` caches. Online application pages are never served from a worker cache.

For a normal application rollback, retain a compatible worker and its offline assets, and use a new cache version for any fallback changes. Removing the registration component or returning a 404 for `/sw.js` does not reliably remove workers already installed on devices.

To retire this PWA worker, deploy a replacement at the same `/sw.js` URL with the same revalidation headers. It must have no fetch handler and use:

```js
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("bam-staff-offline-")) await caches.delete(key);
      }
      await self.registration.unregister();
    })(),
  );
});
```

This retirement exception activates immediately but never reloads windows or deletes other caches. Keep serving the retirement worker for returning devices. Removing a home-screen icon remains a user action.

## Validation

Run web lint, type-check, unit tests, production build, and the `staff-pwa`, `security-and-auth`, and `tenant-sign-in` Playwright suites against the production build. Tests cover cache isolation, both offline languages, online recovery, production CSP, raster dimensions, prompt handling, standalone detection, tenant switching, expired-session redirects, restricted roles, and narrow mobile layouts.

Playwright simulates install events, standalone mode, and mobile platform detection; it does not install an operating-system app. Actual Chrome/Edge installation, Android home-screen launch, and iPhone/iPad Safari installation still require device checks. No merge, push, or production deployment is included in this branch.
