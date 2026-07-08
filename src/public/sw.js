const APP_VERSION = "0.2.0";
const CACHE_NAME = `cursor-remote-control-v${APP_VERSION}`;
const APP_SHELL = [
  "/",
  `/styles.css?v=${APP_VERSION}`,
  `/app.js?v=${APP_VERSION}`,
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable.svg",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function networkFirst(request) {
  return fetch(request)
    .then((response) => {
      if (response.ok && request.method === "GET") {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    })
    .catch(() => caches.match(request));
}

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);

  if (requestUrl.origin !== self.location.origin) return;
  if (requestUrl.pathname.startsWith("/api/")) return;

  // 页面与关键前端资源优先走网络，避免旧壳层挡住更新
  if (
    event.request.mode === "navigate" ||
    requestUrl.pathname === "/app.js" ||
    requestUrl.pathname === "/styles.css" ||
    requestUrl.pathname === "/sw.js" ||
    requestUrl.pathname === "/version.js" ||
    requestUrl.pathname === "/manifest.webmanifest"
  ) {
    event.respondWith(
      networkFirst(event.request).then(
        (response) => response || caches.match("/") || caches.match(event.request),
      ),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (!response.ok || event.request.method !== "GET") return response;
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      });
    }),
  );
});
