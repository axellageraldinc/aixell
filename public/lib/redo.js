// Edit the last message / regenerate the last reply. Both first take the last turn out of the chat's history on the
// server (what Hermes' /undo does), then send the (edited) text again, so the agent starts that turn fresh and the
// model chosen in the composer applies. Only the newest turn, and only plain-text messages (no attachments).
import { h, $ } from './dom.js';
import { icon } from './icons.js';
import { api, agentPath } from './api.js';
import { state, on, liveRun } from './state.js';
import { notify } from './ui.js';
import { loadSession } from './messages.js';
import { sendMessage } from './chat.js';
import { t } from './i18n.js';

const list = $('#message-list');
let busy = false;

const clear = () => list.querySelectorAll('.redo-actions, .redo-btn').forEach((el) => el.remove());

async function redo(textFor) {
  const id = state.sessionId;
  if (!id || busy || liveRun(state.agent, id)) return;
  busy = true;
  let text;
  try {
    const res = await api(`${agentPath(state.agent)}/sessions/${encodeURIComponent(id)}/rewind`, { method: 'POST', body: {} });
    text = textFor(res.text);
  } catch (err) {
    busy = false;
    notify(err.message);
    return;
  }
  await loadSession(id);
  busy = false;
  if (text.trim()) await sendMessage({ text: text.trim(), attachments: [] });
}

function openEditor(userEl) {
  const body = userEl.querySelector('.user-body');
  const original = body.querySelector('p')?.textContent ?? '';
  const area = h('textarea', { className: 'dlg-text redo-text', rows: 3, 'aria-label': t('chat.message.edit'), 'data-testid': 'redo-text' });
  area.value = original;
  const send = h('button', { type: 'button', className: 'btn btn-primary btn-sm', 'data-testid': 'redo-send' }, t('chat.message.resend'));
  const cancel = h('button', { type: 'button', className: 'btn btn-sm', 'data-testid': 'redo-cancel' }, t('common.cancel'));
  const editor = h('div', { className: 'redo-edit' }, area, h('div', { className: 'dlg-row' }, h('span', { className: 'dlg-spacer' }), cancel, send));
  const previous = [...userEl.children];
  userEl.replaceChildren(editor);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  cancel.addEventListener('click', () => userEl.replaceChildren(...previous));
  send.addEventListener('click', () => { send.disabled = true; redo(() => area.value); });
  area.addEventListener('keydown', (event) => { if (event.key === 'Escape') cancel.click(); });
}

function decorate() {
  if (list.querySelector('.redo-edit')) return; // do not rebuild the message while it is being edited
  clear();
  const id = state.sessionId;
  if (!id || state.session?.source === 'telegram' || liveRun(state.agent, id)) return;
  const messages = [...list.querySelectorAll(':scope > .msg')];
  const last = messages.at(-1);
  if (!last?.classList.contains('msg-assistant')) return;
  const user = messages.findLast((el) => el.classList.contains('msg-user'));
  if (!user || user.querySelector('.user-images, .user-files')) return;

  const edit = h('button', { type: 'button', className: 'ibtn ibtn-sm redo-btn', 'aria-label': t('chat.message.edit'), title: t('chat.message.edit'), 'data-testid': 'redo-edit' }, icon('square-pen', 14));
  edit.addEventListener('click', () => openEditor(user));
  user.append(h('div', { className: 'redo-actions' }, edit));

  const again = h('button', { type: 'button', className: 'ibtn ibtn-sm redo-btn', 'aria-label': t('chat.message.retry'), title: t('chat.message.retry'), 'data-testid': 'redo-regenerate' }, icon('refresh', 14));
  again.addEventListener('click', () => redo((text) => text));
  last.querySelector('.meta')?.append(again);
}

export function initRedo() {
  for (const type of ['thread:rendered', 'session:changed']) on(type, decorate);
  on('run:state', () => { if (liveRun(state.agent, state.sessionId)) clear(); });
}
