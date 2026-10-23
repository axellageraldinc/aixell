// "Import from Telegram": Telegram chats, listed in a dialog, read there, and imported into the app, which
// starts a new web chat whose first message carries the end of that conversation.
import { h } from './dom.js';
import { api } from './api.js';
import { emit } from './state.js';
import { sendMessage } from './chat.js';
import { notify } from './ui.js';
import { userNode, assistantNode } from './message-nodes.js';
import { fmtDateTime } from './format.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { APP_NAME } from './brand.js';

let cache = { at: 0, data: [] };
const TTL_MS = 60_000;

export async function loadTelegramChats(force = false) {
  if (!force && Date.now() - cache.at < TTL_MS) return cache.data;
  try {
    cache = { at: Date.now(), data: (await api('/api/telegram/sessions?limit=8')).data ?? [] };
  } catch {
    cache = { at: Date.now(), data: [] };
  }
  return cache.data;
}

const titleOf = (chat) => chat.title || chat.preview || t('telegram.untitled');

// Sidebar entry: opens the list of Telegram chats in a dialog.
export function initTelegramEntry() {
  const button = document.querySelector('#telegram-open');
  if (!button) return;
  button.addEventListener('click', () => openTelegramList());
}

export async function openTelegramList() {
  const opener = document.activeElement;
  const body = h('div', { className: 'dlg-body' }, h('p', { className: 'dlg-note' }, t('common.loading')));
  const shut = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); opener?.focus?.(); };
  const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); shut(); } };
  const close = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('common.close'), onClick: shut }, icon('x', 18));
  const panel = h('div', { className: 'modal-box dlg-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('telegram.import'), 'data-testid': 'telegram-list' },
    h('div', { className: 'dlg-head' }, h('h2', {}, t('telegram.import')), h('span', { className: 'dlg-spacer' }), close), body);
  const overlay = h('div', { className: 'dlg modal modal-open' }, panel);
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) shut(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  const chats = await loadTelegramChats(true);
  if (!overlay.isConnected) return;
  body.replaceChildren(chats.length ? h('div', { className: 'tg-list' }, chats.map((c) => h('button', { type: 'button', className: 'tg-item', 'data-testid': 'telegram-chat', onClick: () => { shut(); openTelegramChat(c); } },
    h('span', { className: 'tg-title' }, titleOf(c)),
    h('span', { className: 'tg-meta' }, fmtDateTime(c.last_active), c.preview ? ` · ${c.preview.replace(/\s+/g, ' ')}` : '')))) : h('p', { className: 'dlg-note' }, t('telegram.empty')));
}

function continuePrompt(title, transcript) {
  return t('telegram.prompt', { title: title ? ` ("${title}")` : '', transcript });
}

export async function openTelegramChat(chat) {
  const opener = document.activeElement;
  const body = h('div', { className: 'dlg-body tg-body' }, h('p', { className: 'dlg-note' }, t('common.loading')));
  const shut = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); opener?.focus?.(); };
  const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); shut(); } };
  const close = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('common.close'), onClick: shut }, icon('x', 18));
  const go = h('button', { type: 'button', className: 'btn btn-primary', 'data-testid': 'telegram-continue', disabled: true }, t('telegram.continue', { app: APP_NAME }));
  const panel = h('div', { className: 'modal-box dlg-panel dlg-telegram', role: 'dialog', 'aria-modal': 'true', 'aria-label': titleOf(chat), 'data-testid': 'telegram-dialog' },
    h('div', { className: 'dlg-head' }, h('div', { className: 'tg-headtext' }, h('h2', {}, titleOf(chat)), h('span', { className: 'up-stamp' }, t('telegram.meta', { time: fmtDateTime(chat.last_active) }))), h('span', { className: 'dlg-spacer' }), close),
    body,
    h('div', { className: 'tg-foot' }, h('span', { className: 'muted' }, t('telegram.readonly', { app: APP_NAME })), go));
  const overlay = h('div', { className: 'dlg modal modal-open' }, panel);
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) shut(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  try {
    const data = await api(`/api/telegram/sessions/${encodeURIComponent(chat.id)}`);
    if (!overlay.isConnected) return;
    const nodes = data.messages.map((m) => (m.role === 'user' ? userNode(m.content, m.timestamp) : assistantNode({ answer: m.content, timestamp: m.timestamp })));
    body.replaceChildren(h('div', { className: 'message-list tg-thread' }, nodes.length ? nodes : h('p', { className: 'dlg-note' }, t('telegram.noMessages'))));
    go.disabled = !data.transcript;
    go.addEventListener('click', async () => {
      shut();
      emit('session:select', null);
      const ok = await sendMessage({ text: continuePrompt(data.session.title, data.transcript), attachments: [] });
      if (ok === false) notify(t('telegram.sendFailed'));
    });
  } catch (err) {
    body.replaceChildren(h('p', { className: 'dlg-note' }, err.message));
  }
}
