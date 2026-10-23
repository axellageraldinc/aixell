// Spending limits (Settings → Budget): a limit per chat and one per day, in the currency the agent's provider bills in, 0 = off. Reaching one does not block
// anything: sending asks "continue?" first, and the cost chip in the header turns amber / red.
import { h } from './dom.js';
import { api, agentPath } from './api.js';
import { state, on } from './state.js';
import { fmtMoney } from './format.js';
import { notify } from './ui.js';
import { t } from './i18n.js';
import { APP_NAME } from './brand.js';

let budget = null;
let today = { at: 0, amount: 0, currency: 'USD' };
const TODAY_TTL_MS = 60_000;

export async function loadBudget(force = false) {
  if (budget && !force) return budget;
  const agent = state.agent;
  try {
    const data = await api(`${agentPath(agent)}/budget`);
    if (agent === state.agent) budget = data;
  } catch { if (agent === state.agent) budget = budget ?? { perChat: 0, perDay: 0 }; }
  return budget ?? { perChat: 0, perDay: 0 };
}

async function todayCost() {
  if (Date.now() - today.at < TODAY_TTL_MS) return today;
  try {
    const data = await api(`${agentPath(state.agent)}/usage?days=1`);
    today = { at: Date.now(), amount: data.totals?.estimatedCost ?? 0, currency: data.currency ?? 'USD' };
  } catch { /* keep the last value */ }
  return today;
}

// 'ok' | 'warn' (80%) | 'danger' (limit reached) for the open chat, from what is already loaded.
export function chatCostLevel() {
  const cost = state.session?.web_cost;
  if (!budget?.perChat || !cost) return 'ok';
  const ratio = cost.amount / budget.perChat;
  return ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warn' : 'ok';
}

function confirmDialog({ title, lines, confirmLabel }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    let done = false;
    const finish = (value) => { if (done) return; done = true; document.removeEventListener('keydown', onKey, true); overlay.remove(); opener?.focus?.(); resolve(value); };
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); finish(false); } };
    const ok = h('button', { type: 'button', className: 'btn btn-primary', 'data-testid': 'budget-continue', onclick: () => finish(true) }, confirmLabel);
    const no = h('button', { type: 'button', className: 'btn', 'data-testid': 'budget-cancel', onclick: () => finish(false) }, t('common.cancel'));
    const panel = h('div', { className: 'modal-box dlg-panel dlg-confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title, 'data-testid': 'budget-dialog' },
      h('div', { className: 'dlg-head' }, h('h2', {}, title)),
      h('div', { className: 'dlg-body' }, lines.map((line) => h('p', { className: 'dlg-note' }, line))),
      h('div', { className: 'confirm-foot' }, no, ok));
    const overlay = h('div', { className: 'dlg modal modal-open' }, panel);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) finish(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    ok.focus();
  });
}

// Asked before a message is sent. Resolves true when sending may go on.
export async function allowSend() {
  const b = await loadBudget();
  if (!b.perChat && !b.perDay) return true;
  const lines = [];
  const cost = state.session?.web_cost;
  if (b.perChat && cost && cost.amount >= b.perChat) lines.push(t('budget.reached.chat', { amount: fmtMoney(cost.amount, cost.currency), limit: fmtMoney(b.perChat, cost.currency) }));
  if (b.perDay) {
    const day = await todayCost();
    if (day.amount >= b.perDay) lines.push(t('budget.reached.day', { amount: fmtMoney(day.amount, day.currency), limit: fmtMoney(b.perDay, day.currency) }));
  }
  if (!lines.length) return true;
  return confirmDialog({ title: t('budget.reached.title'), lines: [...lines, t('budget.reached.question')], confirmLabel: t('budget.reached.confirm') });
}

export function budgetEditor() {
  const field = (label, hint, testid) => {
    const input = h('input', { className: 'input input-sm', type: 'number', min: 0, step: 1000, inputmode: 'numeric', 'data-testid': testid, 'aria-label': label });
    const name = h('span', { className: 'picker-label' }, label);
    return { input, label: name, node: h('div', { className: 'picker-field' }, name, input, h('p', { className: 'picker-hint' }, hint)) };
  };
  const perChat = field(t('budget.chat.label', { currency: today.currency }), t('budget.chat.hint'), 'budget-chat');
  const perDay = field(t('budget.day.label', { currency: today.currency }), t('budget.day.hint'), 'budget-day');
  todayCost().then((cost) => {
    perChat.label.textContent = t('budget.chat.label', { currency: cost.currency });
    perDay.label.textContent = t('budget.day.label', { currency: cost.currency });
  });
  const status = h('span', { className: 'dlg-status', role: 'status' });
  const save = h('button', { type: 'button', className: 'btn btn-sm btn-primary', 'data-testid': 'budget-save' }, t('common.save'));
  loadBudget(true).then((b) => { perChat.input.value = b.perChat || ''; perDay.input.value = b.perDay || ''; });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      budget = await api(`${agentPath(state.agent)}/budget`, { method: 'PUT', body: { perChat: Number(perChat.input.value || 0), perDay: Number(perDay.input.value || 0) } });
      status.textContent = t('common.saved');
      window.dispatchEvent(new Event('hermes:budget'));
    } catch (err) { status.textContent = err.message; notify(err.message); } finally { save.disabled = false; }
  });
  return h('section', {}, h('h3', {}, t('budget.title')),
    h('p', { className: 'dlg-note' }, t('budget.hint', { app: APP_NAME })),
    h('div', { className: 'dlg-body-grid' }, perChat.node, perDay.node),
    h('div', { className: 'dlg-row' }, h('span', { className: 'dlg-spacer' }), status, save));
}

export function initBudget() {
  on('agent:select', () => { budget = null; loadBudget(); });
}
