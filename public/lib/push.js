// "Reply finished" notifications on this device: permission, the push subscription and the threshold (only replies
// that took at least that long notify). The service worker (sw.js) shows them; the server sends the pushes.
import { api } from './api.js';
import { t } from './i18n.js';

export const THRESHOLDS = [[0, t('settings.notify.threshold.all')], [30, t('settings.notify.threshold.30s')], [120, t('settings.notify.threshold.120s')]];

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export const registerWorker = () => (pushSupported() ? navigator.serviceWorker.register('/sw.js').catch(() => null) : Promise.resolve(null));

const keyBytes = (key) => Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// getRegistration, not .ready: that never settles when no worker was registered yet.
async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration('/');
  return registration ? registration.pushManager.getSubscription() : null;
}

// -> { supported, permission, subscribed, minSeconds }
export async function pushState() {
  if (!pushSupported()) return { supported: false, permission: 'denied', subscribed: false, minSeconds: 0 };
  let subscribed = false;
  let minSeconds = Number(localStorage.getItem('hermes-web:push-min') ?? 0);
  try {
    const sub = await currentSubscription();
    if (sub) subscribed = (await api('/api/push/status', { method: 'POST', body: { endpoint: sub.endpoint } })).subscribed;
  } catch { /* unknown: shown as off */ }
  if (!THRESHOLDS.some(([value]) => value === minSeconds)) minSeconds = 0;
  return { supported: true, permission: Notification.permission, subscribed, minSeconds };
}

export async function enablePush(minSeconds) {
  if (!pushSupported()) throw new Error(t('settings.notify.unsupported'));
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission !== 'granted') throw new Error(t('settings.notify.permissionDenied'));
  await registerWorker();
  const registration = await navigator.serviceWorker.ready;
  let sub = await registration.pushManager.getSubscription();
  if (!sub) {
    const { key } = await api('/api/push/key');
    sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  }
  await api('/api/push/subscribe', { method: 'POST', body: { endpoint: sub.endpoint, minSeconds } });
  try { localStorage.setItem('hermes-web:push-min', String(minSeconds)); } catch { /* per-page only */ }
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

export async function sendTestPush() {
  const sub = await currentSubscription();
  if (!sub) throw new Error(t('settings.notify.notActive'));
  const { sent } = await api('/api/push/test', { method: 'POST', body: { endpoint: sub.endpoint } });
  if (!sent) throw new Error(t('settings.notify.pushRejected'));
}
