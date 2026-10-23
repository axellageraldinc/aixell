// Picks up what the system Share sheet handed to the app (see sw.js): returns { text, files } once, or null.
import { t } from './i18n.js';
const CACHE = 'hermes-share';

export async function takeShared() {
  if (!new URLSearchParams(location.search).has('share')) return null;
  history.replaceState(null, '', location.pathname + location.hash);
  try {
    const cache = await caches.open(CACHE);
    const metaRes = await cache.match('/share-data/meta');
    if (!metaRes) return null;
    const { text } = await metaRes.json();
    const files = [];
    for (const request of await cache.keys()) {
      if (!new URL(request.url).pathname.startsWith('/share-data/file-')) continue;
      const res = await cache.match(request);
      const blob = await res.blob();
      files.push(new File([blob], decodeURIComponent(res.headers.get('X-File-Name') || t('share.fallbackName')), { type: blob.type }));
    }
    for (const key of await cache.keys()) await cache.delete(key);
    return text || files.length ? { text: text || '', files } : null;
  } catch {
    return null;
  }
}
