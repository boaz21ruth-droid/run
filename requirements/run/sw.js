/* WeRun Service Worker · 静态资源缓存优先，HTML 网络优先（离线时回退缓存） */
var VERSION = "werun-v7-1";
var PRECACHE = [
  "./", "./index.html", "./assets/app.js", "./assets/run-domain.js",
  "./assets/fonts/Inter-latin-var.woff2", "./assets/fonts/NotoSansKhmer-khmer-var.woff2",
  "./assets/hero-mobile.webp", "./assets/hero-desktop-sm.webp", "./assets/hero-desktop.webp",
  "./assets/icon.svg", "./manifest.webmanifest"
];
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(PRECACHE); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  var isHtml = req.mode === "navigate" || (req.headers.get("accept") || "").indexOf("text/html") >= 0;
  if (isHtml) {
    e.respondWith(fetch(req).then(function (res) {
      var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); return res;
    }).catch(function () { return caches.match(req).then(function (r) { return r || caches.match("./index.html"); }); }));
    return;
  }
  e.respondWith(caches.match(req).then(function (hit) {
    return hit || fetch(req).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); }
      return res;
    });
  }));
});
