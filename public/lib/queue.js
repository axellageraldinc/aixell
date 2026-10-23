// Messages written while a reply is still running go straight into that reply ("steer"); only a message that carries
// files has to wait, because a steer is text only. The list below is that waiting room. It survives a reload
// (sessionStorage), so a queued message is never lost by refreshing the page.
import { h, $ } from './dom.js';
import { icon } from './icons.js';
import { state, emit, on, sessionKey, liveRun } from './state.js';
import { t } from './i18n.js';

const listEl = $('#queue');
const STORE_KEY = 'hermes-web:queue';
let nextId = 1;
const queues = new Map(); // key -> { items: [{ id, text, attachments }], paused: boolean }

const current = () => sessionKey(state.agent, state.sessionId);
const slot = (key) => {
  if (!queues.has(key)) queues.set(key, { items: [], paused: false });
  return queues.get(key);
};

// Attachments are files already on the server; only their ids and names are worth keeping across a reload.
function save() {
  try {
    const plain = {};
    for (const [key, q] of queues) if (q.items.length) plain[key] = q.items;
    sessionStorage.setItem(STORE_KEY, JSON.stringify(plain));
  } catch { /* storage full or unavailable: the queue lives in this page only */ }
}

function restore() {
  try {
    const plain = JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}');
    for (const [key, items] of Object.entries(plain)) {
      if (!Array.isArray(items) || items.length === 0) continue;
      const q = slot(key);
      for (const item of items) {
        if (!item || typeof item.text !== 'string') continue;
        q.items.push({ id: nextId++, text: item.text, attachments: Array.isArray(item.attachments) ? item.attachments : [] });
      }
    }
  } catch { /* nothing to restore */ }
}

export const queued = (key = current()) => queues.get(key)?.items ?? [];
export const isPaused = (key = current()) => Boolean(queues.get(key)?.paused);

export function enqueue(item, { key = current(), front = false } = {}) {
  const entry = { id: nextId++, text: item.text, attachments: item.attachments ?? [] };
  const q = slot(key);
  front ? q.items.unshift(entry) : q.items.push(entry);
  changed();
  return entry;
}

export function remove(id, key = current()) {
  const q = queues.get(key);
  if (!q) return;
  q.items = q.items.filter((item) => item.id !== id);
  changed();
}

export function takeNext(key = current()) {
  const item = queues.get(key)?.items.shift() ?? null;
  if (item) changed();
  return item;
}

export function setPaused(key, value) {
  const q = slot(key);
  if (q.paused === value) return;
  q.paused = value;
  changed();
}

// A new chat became a real session while its run was going: its queue moves with it.
export function rekeyQueue(from, to) {
  const q = queues.get(from);
  if (!q) return;
  queues.delete(from);
  queues.set(to, q);
  changed();
}

function changed() {
  save();
  render();
  emit('queue:changed');
}

// onSend(item) is supplied by the composer; a queued item is sent when the chat is idle.
let handlers = { send: () => {} };
export const bindQueue = (next) => { handlers = next; };

function render() {
  const items = queued();
  listEl.hidden = items.length === 0;
  const running = Boolean(liveRun(state.agent, state.sessionId));
  const paused = isPaused();
  const rows = items.map((item, index) => {
    const label = item.text || (item.attachments.length === 1
      ? t('queue.attachmentsOne', { n: item.attachments.length })
      : t('queue.attachments', { n: item.attachments.length }));
    return h(
      'li',
      { className: 'queue-item', 'data-testid': 'queue-item' },
      h('span', { className: 'queue-n' }, String(index + 1)),
      h('span', { className: 'queue-text', title: item.text }, label),
      item.attachments.length && item.text ? h('span', { className: 'queue-att' }, icon('paperclip', 12), String(item.attachments.length)) : null,
      !running ? h('button', { type: 'button', className: 'btn btn-sm btn-ghost queue-act', 'data-testid': 'queue-send', onClick: () => handlers.send(item) }, t('queue.sendNow')) : null,
      h('button', { type: 'button', className: 'ibtn ibtn-sm', 'aria-label': t('queue.remove'), onClick: () => remove(item.id) }, icon('x', 14)),
    );
  });
  listEl.replaceChildren(
    ...(items.length ? [h('li', { className: 'queue-head' }, paused ? t('queue.paused') : t('queue.waiting', { n: items.length }))] : []),
    ...rows,
  );
}

export function initQueue() {
  restore();
  for (const type of ['session:changed', 'run:state', 'chat:reset']) on(type, render);
  render();
}
