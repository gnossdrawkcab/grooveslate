const CACHE = "grooveslate-shell-v2";
const SHELL = ["/styles.css?v=20260813-15", "/app.js?v=20260813-15", "/practice.js?v=20260813-15", "/logo.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === "navigate") return;
  if (new URL(event.request.url).pathname.startsWith("/api/") || event.request.headers.has("range")) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok && ["script", "style", "image", "manifest"].includes(event.request.destination)) {
      caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    }
    return response;
  }).catch(() => caches.match(event.request)));
});
