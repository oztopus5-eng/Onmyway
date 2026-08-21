/* On My Way — service worker
   Two jobs: keep the app openable offline, and deliver alerts when the tab is closed. */
const CACHE = "omw-v1.6.0";
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== "GET") return;   // never cache API calls
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return r;
    }).catch(() => caches.match("./index.html")))
  );
});

/* ---- the alert queue, written by the page into IndexedDB ---- */
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("omw", 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("q")) r.result.createObjectStore("q", { keyPath: "id" }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function due() {
  const d = await db();
  const items = await new Promise(res => {
    const rq = d.transaction("q", "readonly").objectStore("q").getAll();
    rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
  });
  const t = Date.now();
  return items.filter(i => !i.sent && i.at <= t && t - i.at < 30 * 60000);
}
async function markSent(ids) {
  const d = await db(), tx = d.transaction("q", "readwrite"), st = tx.objectStore("q");
  for (const id of ids) {
    await new Promise(res => {
      const g = st.get(id);
      g.onsuccess = () => { const v = g.result; if (v) { v.sent = Date.now(); st.put(v); } res(); };
      g.onerror = () => res();
    });
  }
}
async function check() {
  const items = await due();
  if (!items.length) return;
  for (const i of items) {
    await self.registration.showNotification(i.title, {
      body: i.body, tag: i.id, data: { id: i.id },
      icon: "./icon-192.png", badge: "./icon-192.png",
      requireInteraction: !!i.urgent, silent: false
    });
  }
  await markSent(items.map(i => i.id));
}

self.addEventListener("periodicsync", e => { if (e.tag === "omw-check") e.waitUntil(check()); });
self.addEventListener("sync", e => { if (e.tag === "omw-check") e.waitUntil(check()); });
self.addEventListener("message", e => { if (e.data === "check") e.waitUntil(check()); });
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil(self.registration.showNotification(d.title || "On My Way", { body: d.body || "", icon: "./icon-192.png" }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.id;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if ("focus" in c) { c.postMessage({ open: id }); return c.focus(); }
    return clients.openWindow("./index.html" + (id ? "#e=" + encodeURIComponent(id) : ""));
  }));
});
