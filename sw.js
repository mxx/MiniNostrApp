// MiniNostrApp service worker — download once, works offline.
//
// Install precaches the app shell; the fetch handler is cache-first for
// same-origin GET requests, so hashed bundle assets (assets/index-*.js/css,
// whose names change every build) are cached on first fetch without being
// hardcoded here. Navigation requests fall back to the cached index.html
// when the network is unreachable. Relay traffic is never same-origin GET
// (WebSocket), so it is never intercepted.
//
// Bump CACHE_VERSION on every release whose bundle changes; activate drops
// caches from older versions.

// x-release-please: bump on release
const CACHE_VERSION = "v1";
const CACHE_NAME = `mininostr-app-${CACHE_VERSION}`;
const PRECACHE_URLS = ["./", "./index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // relays & CDNs: leave alone

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => {
          // Offline: navigations get the app shell, subresources get
          // whatever the cache has (possibly nothing).
          if (request.mode === "navigate") return caches.match("./index.html");
          return caches.match(request);
        });
    }),
  );
});
