// Chat header: session title, context meter and the New chat button.
import { $ } from './dom.js';
import { state, emit, on } from './state.js';
import { fmtCompact, fmtMoney } from './format.js';
import { contextInfo } from './models.js';
import { displayTitle } from './session-row.js';
import { provisionalTitle } from './auto-title.js';
import { chatCostLevel, initBudget } from './budget.js';
import { openShareDialog } from './share-chat.js';
import { t } from './i18n.js';

const titleEl = $('#chat-title');
const meter = $('#context-meter');
const fill = $('#context-fill');
const meterText = $('#context-text');
const costChip = $('#cost-chip');
const costText = $('#cost-text');

function renderTitle() {
  // A chat that only just started is not in the list yet; its first message already names it.
  const s = state.session ?? state.sessions.find((x) => x.id === state.sessionId) ?? (provisionalTitle(state.sessionId) ? { id: state.sessionId } : null);
  const shown = state.sessionId && s ? displayTitle(s) : { text: t('chat.new'), typing: false };
  titleEl.textContent = shown.text;
  titleEl.classList.toggle('is-typing', shown.typing);
  titleEl.title = state.sessionId ? t('chat.id.tooltip', { id: state.sessionId }) : '';
}

function renderMeter() {
  const { used, approx, windowSize, ratio, level } = contextInfo();
  // Unknown is a dash only for an existing chat; a new chat has simply used nothing yet.
  // Nothing used yet (new chat) or unknown: the meter says nothing, so it stays out of the way.
  meter.hidden = !(used > 0);
  const usedText = used == null ? (state.sessionId ? '—' : '0') : `${approx ? '~' : ''}${fmtCompact(used)}`;
  meterText.textContent = windowSize ? `${usedText} / ${fmtCompact(windowSize)}` : usedText;
  meter.title = approx ? t('chat.context.hintApprox') : t('chat.context.hint');
  fill.style.width = ratio == null ? '0%' : `${Math.min(100, ratio * 100).toFixed(1)}%`;
  meter.dataset.level = level;
  meter.setAttribute('aria-label', t('chat.context.aria', { text: meterText.textContent }));
}

function renderCost() {
  const cost = state.session?.web_cost;
  costChip.hidden = !state.sessionId || !cost || !(cost.amount > 0);
  costChip.dataset.level = chatCostLevel();
  if (cost) costText.textContent = `${cost.basis === 'list-price' ? '≈ ' : ''}${fmtMoney(cost.amount, cost.currency)}`;
}

export function initHeader() {
  costChip.addEventListener('click', () => emit('inspector:toggle'));
  meter.addEventListener('click', () => emit('inspector:toggle'));
  const shareButton = $('#topbar-share');
  shareButton.addEventListener('click', () => openShareDialog(state.session ?? state.sessions.find((x) => x.id === state.sessionId) ?? { id: state.sessionId }));
  const renderShare = () => { shareButton.hidden = !state.sessionId; };
  on('session:changed', renderShare);
  renderShare();
  $('#topbar-new').addEventListener('click', () => emit('session:select', null));
  for (const type of ['session:changed', 'sessions:reload', 'sessions:loaded']) on(type, renderTitle);
  for (const type of ['session:changed', 'settings:changed', 'models:changed', 'usage:changed', 'context:changed']) on(type, renderMeter);
  for (const type of ['session:changed', 'usage:changed', 'context:changed']) on(type, renderCost);
  initBudget();
  window.addEventListener('hermes:budget', renderCost);
  renderTitle();
  renderMeter();
  renderCost();
}
