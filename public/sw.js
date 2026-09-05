// BastiGrid service worker: the whole prototype works with no signal after one online visit.
// Precaches the shell, the block data and the pre-baked meshes; caches app chunks and imagery
// tiles as they are fetched; serves the cached shell for any navigation when offline.
// ponytail: hand-written runtime caching. Move to Serwist when the app grows past one page.
const VERSION = "bastigrid-v1";
const SHELL = ["/", "/manifest.json", "/data/dharavi-osm.json", "/data/heights.json", "/nav/manifest.json", "/nav/stretcher.bin", "/nav/walker.bin"];
const IMAGERY_HOST = "server.arcgisonline.com";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function cacheable(url) {
  if (url.hostname === IMAGERY_HOST) return true;
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  return p.startsWith("/_next/static/") || p.startsWith("/data/") || p.startsWith("/nav/") || p.startsWith("/icons/") || p === "/manifest.json";
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (request.mode === "navigate") {
    // network first so updates land, cached shell when offline (query strings like ?demo still resolve client-side)
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  if (!cacheable(url)) return;
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
