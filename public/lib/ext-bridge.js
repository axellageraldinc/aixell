// When the app is shown inside the aixell browser extension's side panel, the extension can put text (a page the user chose to
// attach) into the message box. Only the parent window, and only from an extension origin the server lists, is listened to.
// The text lands in the box for the user to read and send; nothing is sent by itself.
import { api } from './api.js';
import { emit } from './state.js';

export async function initExtensionBridge() {
  if (window.parent === window) return;
  let origins = [];
  try { origins = (await api('/api/browser/status')).extensionOrigins ?? []; } catch { return; }
  if (!origins.length) return;
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !origins.includes(event.origin)) return;
    const data = event.data;
    if (data?.type === 'aixell-chrome:new-chat') { emit('session:select', null); return; } // the same as "New chat" in the app
    if (!data || data.type !== 'aixell-chrome:insert' || typeof data.text !== 'string') return;
    window.dispatchEvent(new CustomEvent('hermes:shared', { detail: { text: data.text.slice(0, 60000), append: true } }));
  });
  window.parent.postMessage({ type: 'aixell-chrome:ready' }, origins[0]);
}
