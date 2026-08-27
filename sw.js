/* On My Way — service worker
   Two jobs: keep the app openable offline, and deliver alerts when the tab is closed. */
const CACHE = "omw-v1.8.1";
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
/**
 * Code is network-first: always try for a fresh copy so an upload actually
 * shows up. Cache is only the fallback for when you're offline.
 * Images stay cache-first — they never change.
 */
const CODEish = p => /\.(html|js|json)$|\/$/.test(p);
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== "GET") return;   // never touch API calls

  if (e.request.mode === "navigate" || CODEish(u.pathname)) {
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return r;
      }).catch(() => caches.match(e.request).then(hit => hit || caches.match("./index.html")))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return r;
    }))
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
async function all() {
  const d = await db();
  return new Promise(res => {
    const rq = d.transaction("q", "readonly").objectStore("q").getAll();
    rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
  });
}
/** Anything whose moment has arrived. */
async function due() {
  const t = Date.now();
  return (await all()).filter(i => !i.sent && i.at <= t && t - i.at < 30 * 60000);
}
/** Anything landing in the next 70 seconds — we were woken early on purpose. */
async function soon() {
  const t = Date.now();
  return (await all()).filter(i => !i.sent && i.at > t && i.at - t < 70000);
}

const gapText = ms => {
  const m = Math.round(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return h + "h" + (r ? " " + r + "m" : "");
  const d = Math.round(h / 24);
  return d + " day" + (d > 1 ? "s" : "");
};
/** Worked out at the instant it's shown, never when it was queued. */
const bodyNow = i => String(i.body || "").replace("{gap}",
  gapText(Math.max(0, (i.start || Date.now()) - Date.now())));
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
  if (!items.length) return 0;
  for (const i of items) {
    await self.registration.showNotification(i.title, {
      body: bodyNow(i), tag: i.id, data: { id: i.id },
      icon: "./icon-192.png", badge: "./icon-192.png",
      requireInteraction: !!i.urgent, silent: false
    });
  }
  await markSent(items.map(i => i.id));
  return items.length;
}

self.addEventListener("periodicsync", e => { if (e.tag === "omw-check") e.waitUntil(check()); });
self.addEventListener("sync", e => { if (e.tag === "omw-check") e.waitUntil(check()); });
self.addEventListener("message", e => { if (e.data === "check") e.waitUntil(check()); });
/**
 * The push carries nothing. It's only a nudge to wake up and look at the
 * queue we already stored, which is why none of your schedule is ever
 * sent to a server.
 */
/**
 * The cron can only fire on the minute, so it wakes us up to 60s early.
 * Rather than alerting early or waiting for the next sweep and being late,
 * we hold here for the exact remaining seconds and fire on the moment.
 */
async function checkPrecise() {
  let n = await check();
  const pending = await soon();
  if (!pending.length) return n;
  const wait = Math.min(...pending.map(i => i.at - Date.now()));
  if (wait > 0 && wait < 70000) await new Promise(r => setTimeout(r, wait + 250));
  return n + await check();
}

self.addEventListener("push", e => {
  e.waitUntil(checkPrecise().then(async n => {
    if (n) return;
    // iOS insists on something visible for every push it delivers
    const shown = await self.registration.getNotifications();
    if (!shown.length) {
      await self.registration.showNotification("On My Way", {
        body: "Checking your schedule…", tag: "omw-wake", silent: true, icon: "./icon-192.png"
      });
      setTimeout(async () => {
        for (const x of await self.registration.getNotifications({ tag: "omw-wake" })) x.close();
      }, 4000);
    }
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.id;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if ("focus" in c) { c.postMessage({ open: id }); return c.focus(); }
    return clients.openWindow("./index.html" + (id ? "#e=" + encodeURIComponent(id) : ""));
  }));
});
