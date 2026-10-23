// Service worker for "reply finished" notifications and for receiving shares (the system Share sheet -> the app). Its only
// fetch handler answers POST /share-target; every other request goes to the network untouched and nothing is cached
// for reuse, so it can never serve an old version of the app. The push itself has no body: on a push it asks the server what finished.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Share target: the browser POSTs the shared text / link / files here. They are parked in a cache for the page to pick up
// (the page reads and deletes them right away), then the browser is sent to the app.
// Mirrors APP_NAME in public/lib/brand.js: a classic service worker cannot import an ES module.
const APP_NAME = 'aixell';
const SHARE_CACHE = 'hermes-share';
const MAX_SHARED_FILES = 5;
const MAX_SHARED_BYTES = 25 * 1024 * 1024;

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);
    for (const key of await cache.keys()) await cache.delete(key);
    const text = ['title', 'text', 'url'].map((name) => String(form.get(name) ?? '').trim()).filter(Boolean);
    await cache.put('/share-data/meta', new Response(JSON.stringify({ text: [...new Set(text)].join('\n') })));
    let n = 0;
    for (const file of form.getAll('files')) {
      if (!(file instanceof File) || n >= MAX_SHARED_FILES || file.size > MAX_SHARED_BYTES) continue;
      await cache.put(`/share-data/file-${n}`, new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name || `shared-${n}`) } }));
      n += 1;
    }
  } catch { /* an unreadable share just opens the app */ }
  return Response.redirect('/?share=1', 303);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method === 'POST' && new URL(request.url).pathname === '/share-target') event.respondWith(receiveShare(request));
});

// A push with no body: the service worker asks the server what finished. `showNotification` must run for every push the
// browser delivers — Chrome drops the subscription (and stops waking this worker) after a push that shows nothing, so
// every path below ends in a notification.
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let info = null;
    try {
      const res = await fetch('/api/push/last', { credentials: 'same-origin', cache: 'no-store' });
      if (res.ok) info = await res.json();
    } catch { /* offline or signed out: show the generic text */ }
    // `{}` is truthy: an empty answer (server restarted, nothing announced) must not count as "we know what this is".
    const known = Boolean(info && typeof info.heading === 'string');
    // Someone is looking at the app right now: the reply is already on screen, so the banner would be redundant. A test
    // push is shown anyway — it exists precisely to prove the notification path works.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const watching = windows.some((client) => client.visibilityState === 'visible' && client.focused);
    if (watching && known && !info.test) {
      report('suppressed', info);
      return;
    }
    await self.registration.showNotification(known ? info.heading : APP_NAME, {
      body: (known && info.body) || 'Your reply is ready.',
      icon: '/icon-192.png',
      // Android draws `badge` as a silhouette: only its alpha channel is used and the system tints it. The app icon is an
      // opaque dark square, so as a badge it came out as a solid white box. `icon-badge.png` is the same mark with a
      // transparent background, which is what a status-bar icon has to be.
      badge: '/icon-badge.png',
      tag: known && typeof info.tag === 'string' && /^[\w-]{1,40}$/.test(info.tag) ? info.tag : 'hermes-web-reply',
      renotify: true,
      vibrate: [80, 40, 80],
      silent: false,
      data: { url: typeof info?.url === 'string' && info.url.startsWith('/') ? info.url : '/' },
    });
    report('shown', info);
  })());
});

// Tells the server what this device did with a push, so "no notification appeared" is answerable from the journal
// instead of guesswork. Best effort: a failure here must never break the notification itself.
function report(action, info) {
  fetch('/api/push/ack', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, heading: info?.heading ?? null }),
  }).catch(() => {});
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      if ('navigate' in open) await open.navigate(url).catch(() => {});
      return;
    }
    await self.clients.openWindow(url);
  })());
});
