/* Staff documents are always fetched from the network. Only public offline assets enter Cache Storage. */
const CACHE_PREFIX = "bam-staff-offline-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const ASSETS = [
  "/pwa/offline-en.html",
  "/pwa/offline-hu.html",
  "/pwa/offline.css",
  "/booking-and-more-mark.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        cache.addAll(
          ASSETS.map((url) => new Request(url, { cache: "reload", credentials: "omit" })),
        ),
      ),
  );
  // No skipWaiting: updates must not interrupt a running workspace.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (ASSETS.includes(url.pathname) && !url.search) {
    event.respondWith(
      caches
        .open(CACHE_NAME)
        .then(async (cache) => (await cache.match(url.pathname)) ?? fetch(request)),
    );
    return;
  }

  // RSC, API, public booking/chat and management links must never receive HTML fallbacks.
  if (request.mode !== "navigate") return;
  const path = url.pathname.replace(/^\/(en|hu)(?=\/|$)/, "").replace(/\/$/, "");
  const staff = /^\/dashboard(?:\/|$)/.test(path) || /^\/(?:[^/]+\/)?sign-in$/.test(path);
  if (!staff) return;

  event.respondWith(
    fetch(request, { cache: "no-store" }).catch(async () => {
      const locale = /^\/en(?:\/|$)/.test(url.pathname) ? "en" : "hu";
      const fallback = await (await caches.open(CACHE_NAME)).match(`/pwa/offline-${locale}.html`);
      return fallback ?? Response.error();
    }),
  );
});
