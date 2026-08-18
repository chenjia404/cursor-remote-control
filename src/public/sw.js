const APP_VERSION = "0.4.5";
const CACHE_NAME = `cursor-remote-control-v${APP_VERSION}`;
const APP_SHELL = [
  "/",
  `/styles.css?v=${APP_VERSION}`,
  `/boot.js?v=${APP_VERSION}`,
  `/app.js?v=${APP_VERSION}`,
  `/i18n.js?v=${APP_VERSION}`,
  "/vendor/marked.esm.js",
  "/vendor/purify.es.mjs",
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
  if (requestUrl.pathname.startsWith("/api/") || event.request.method !== "GET") return;

  if (
    event.request.mode === "navigate" ||
    requestUrl.pathname === "/app.js" ||
    requestUrl.pathname === "/boot.js" ||
    requestUrl.pathname === "/i18n.js" ||
    requestUrl.pathname === "/styles.css" ||
    requestUrl.pathname === "/sw.js" ||
    requestUrl.pathname === "/version.js" ||
    requestUrl.pathname.startsWith("/vendor/") ||
    requestUrl.pathname === "/manifest.webmanifest"
  ) {
    event.respondWith(
      networkFirst(event.request).then((response) => {
        if (response) return response;
        // 导航失败才回退首页；CSS/JS 不能回退成 HTML，否则浏览器会当成 404/MIME 错误
        if (event.request.mode === "navigate") {
          return caches.match("/") || caches.match(event.request);
        }
        return caches.match(event.request);
      }),
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
