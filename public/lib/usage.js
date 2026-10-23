// Info chat (the drawer): this chat only (key/value rows + context bar). The agent-wide statistics are in the Usage dialog.
import { h, $ } from './dom.js';
import { api, agentPath } from './api.js';
import { state, on } from './state.js';
import { statusBlock, skeletonRows } from './ui.js';
import { fmtInt, fmtCompact, fmtMoney } from './format.js';
import { contextInfo } from './models.js';
import { copyWithFeedback } from './clipboard.js';
import { barChart } from './chart.js';
import { t } from './i18n.js';

const DAYS = 30;
const sessionEl = $('#usage-session');

const section = (title, ...children) => h('section', { className: 'usage-section' }, h('h3', {}, title), children);
const kv = (rows) => h('dl', { className: 'kv' }, rows.map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value))));

function contextBar() {
  const { used, approx, windowSize, ratio, level } = contextInfo();
  if (used == null) return h('p', { className: 'muted' }, t('usage.context.empty'));
  const fill = h('span', { className: `level-${level}` });
  fill.style.width = ratio == null ? '0%' : `${Math.min(100, ratio * 100).toFixed(1)}%`;
  const caption = windowSize
    ? `${approx ? '~' : ''}${fmtInt(used)} / ${fmtInt(windowSize)} · ${Math.round(ratio * 100)}%${approx ? ` ${t('usage.context.average')}` : ''}`
    : t('usage.context.unknownSize', { used: fmtInt(used) });
  return h(
    'div',
    { className: 'context-bar' },
    windowSize
      ? h('div', { className: 'ctx-track', role: 'meter', 'aria-label': t('usage.context.label'), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(ratio * 100) }, fill)
      : null,
    h('p', {}, caption),
  );
}

// The chat ID as a button that copies it (it also works as a link: #/<agent>/<id>).
function idChip(id) {
  const button = h('button', { type: 'button', className: 'id-chip', 'data-testid': 'chat-id', title: t('sessions.row.copyId') }, id);
  button.addEventListener('click', () => copyWithFeedback(id, (ok) => {
    button.dataset.state = ok === null ? '' : ok ? 'copied' : 'failed';
  }));
  return button;
}

function renderSession() {
  const s = state.session;
  if (!state.sessionId || !s) {
    sessionEl.replaceChildren(section(t('usage.session.title'), h('p', { className: 'muted' }, t('usage.session.empty'))));
    return;
  }
  sessionEl.replaceChildren(
    section(
      t('usage.session.title'),
      kv([
        [t('usage.session.id'), idChip(s.id)],
        [t('usage.session.input'), fmtInt(s.input_tokens)],
        [t('usage.session.output'), fmtInt(s.output_tokens)],
        [t('usage.session.cacheRead'), fmtInt(s.cache_read_tokens)],
        [t('usage.session.reasoning'), fmtInt(s.reasoning_tokens)],
        [t('usage.session.apiCalls'), fmtInt(s.api_call_count)],
        [t('usage.session.cost'), s.web_cost ? `${s.web_cost.basis === 'list-price' ? '≈ ' : ''}${fmtMoney(s.web_cost.amount, s.web_cost.currency)}` : '—'],
      ]),
      contextBar(),
    ),
  );
}

// Last 30 days of the whole agent (every chat). Not part of the per-chat panel: it lives in the account menu → Usage, tab "30-day stats".
export function agentUsageNode() {
  const agent = state.agent;
  const el = h('div', { className: 'usage-agent', 'data-testid': 'usage-agent' }, ...skeletonRows(4, 'skeleton-line'));
  const load = async () => {
    el.replaceChildren(...skeletonRows(4, 'skeleton-line'));
    try {
      const data = await api(`${agentPath(agent)}/usage?days=${DAYS}`);
      renderAgent(el, data);
    } catch (err) {
      el.replaceChildren(statusBlock({ kind: 'error', text: err.message, onRetry: load }));
    }
  };
  load();
  return el;
}

function renderAgent(el, { totals, byDay, byModel, currency }) {
  el.replaceChildren(
    section(
      t('usage.period.days', { days: DAYS }),
      kv([
        [t('usage.period.sessions'), fmtInt(totals.sessions)],
        [t('usage.session.apiCalls'), fmtInt(totals.apiCalls)],
        [t('usage.session.input'), fmtInt(totals.inputTokens)],
        [t('usage.session.output'), fmtInt(totals.outputTokens)],
        [t('usage.session.cacheRead'), fmtInt(totals.cacheReadTokens)],
        [t('usage.session.reasoning'), fmtInt(totals.reasoningTokens)],
        [t('usage.session.cost'), fmtMoney(totals.estimatedCost, currency)],
      ]),
      byDay?.length ? h('div', { className: 'usage-chart' }, h('p', { className: 'muted' }, t('usage.chart.label')), barChart(byDay, currency)) : h('p', { className: 'muted' }, t('usage.chart.empty')),
    ),
    section(t('usage.models.title'), modelTable((byModel ?? []).filter((r) => r.apiCalls > 0), currency)),
  );
}

function modelTable(rows, currency) {
  if (rows.length === 0) return h('p', { className: 'muted' }, t('usage.models.empty'));
  const cell = (text, className) => h('td', { className }, text);
  return h(
    'div',
    { className: 'table-wrap' },
    h(
      'table',
      { className: 'usage-table' },
      h('thead', {}, h('tr', {}, [t('usage.models.model'), t('usage.models.apiCalls'), t('usage.models.inOut'), t('usage.models.cost')].map((label, i) => h('th', { scope: 'col', className: i ? 'num' : '' }, label)))),
      h(
        'tbody',
        {},
        rows.map((r) =>
          h(
            'tr',
            {},
            cell(r.model ?? '—', 'mono'),
            cell(fmtInt(r.apiCalls), 'num'),
            cell(`${fmtCompact(r.inputTokens)} / ${fmtCompact(r.outputTokens)}`, 'num'),
            cell(fmtMoney(r.estimatedCost, currency), 'num'),
          ),
        ),
      ),
    ),
  );
}

export function initUsage() {
  for (const type of ['session:changed', 'models:changed', 'settings:changed', 'usage:changed', 'context:changed']) on(type, renderSession);
  renderSession();
}
