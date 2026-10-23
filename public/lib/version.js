// Which build of the app this page is running, and whether a newer one has been deployed. The server stamps every local
// script/style URL with a build id (?v=…); a page started from an installed app can be an old one, so it compares itself
// with what the server serves now and offers a reload.
import { $ } from './dom.js';
import { t } from './i18n.js';
import { APP_NAME } from './brand.js';

const stamp = (text) => text.match(/app\.css\?v=([\w]+)/)?.[1] ?? null;
export const appVersion = stamp(document.querySelector('link[href*="app.css"]')?.getAttribute('href') ?? '');

export async function latestVersion() {
  try {
    const res = await fetch('/', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'text/html' } });
    return res.ok ? stamp(await res.text()) : null;
  } catch { return null; }
}

// Drops every cache the page can reach and loads it afresh.
export async function hardReload() {
  try { for (const name of await caches.keys()) await caches.delete(name); } catch { /* no Cache API */ }
  try { for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.update(); } catch { /* no worker */ }
  location.reload();
}

const CHECK_EVERY_MS = 10 * 60_000;

export function initUpdateCheck() {
  const banner = $('#update-banner');
  let shown = false;
  const check = async () => {
    if (shown || document.visibilityState !== 'visible' || !appVersion) return;
    const latest = await latestVersion();
    if (!latest || latest === appVersion) return;
    shown = true;
    banner.replaceChildren();
    const text = document.createElement('button');
    text.type = 'button';
    text.className = 'quota-text';
    text.textContent = t('app.update.available', { app: APP_NAME });
    text.addEventListener('click', hardReload);
    banner.append(text);
    banner.hidden = false;
  };
  document.addEventListener('visibilitychange', check);
  setInterval(check, CHECK_EVERY_MS);
  setTimeout(check, 4000);
}
