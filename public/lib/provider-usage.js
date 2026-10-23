// Subscription usage of the current agent's provider (e.g. OpenCode Go rolling / weekly / monthly windows),
// shown at the top of the account menu. Cached briefly so the menu opens instantly.
import { agentUsageNode } from './usage.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { api, agentPath } from './api.js';
import { state } from './state.js';
import { fmtResetsIn, fmtMoney, fmtInt, fmtCompact, fmtDateTime } from './format.js';
import { t } from './i18n.js';

const TTL_MS = 30_000;
const STALE_MS = 10 * 60_000;
const cache = new Map();
const inflight = new Map();

export const peekProviderUsage = () => {
  const hit = cache.get(state.agent);
  return hit && Date.now() - hit.at < STALE_MS ? hit : null;
};

export async function loadProviderUsage({ force = false } = {}) {
  const agent = state.agent;
  if (!agent) return null;
  const hit = cache.get(agent);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.data;
  // Several parts ask at start-up (the quota banner, the menu card): they share one request.
  const key = `${agent}|${force}`;
  if (!inflight.has(key)) {
    inflight.set(key, api(`${agentPath(agent)}/provider-usage${force ? '?fresh=1' : ''}`)
      .then((data) => { cache.set(agent, { at: Date.now(), data }); return data; })
      .finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

let periodKey = 'today';
try { periodKey = localStorage.getItem('hermes-web:usage-period') === 'month' ? 'month' : 'today'; } catch { /* storage blocked */ }

// Spend and per-model breakdown for one period; the toggle swaps it in place.
function periodView(data) {
  const body = h('div', { className: 'up-body' });
  const tabs = h('div', { className: 'up-tabs tabs tabs-box tabs-sm', role: 'tablist' });
  const money = (n) => fmtMoney(n, data.currency);
  const draw = () => {
    const p = data.periods[periodKey];
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.key === periodKey));
    if (!p) { body.replaceChildren(h('div', { className: 'uw-reset' }, t('usage.provider.noData'))); return; }
    const paid = p.models.filter((m) => m.kind === 'payg');
    const free = p.models.filter((m) => m.kind === 'free');
    const plan = p.models.filter((m) => m.kind !== 'payg' && m.kind !== 'free' && m.kind !== 'idle');
    const idle = p.models.filter((m) => m.kind === 'idle');
    const paidTotal = Math.max(p.paid, 1);
    const stats = (m) => `${t('usage.provider.requests', { n: fmtInt(m.requests) })}${m.tokens ? ` · ${t('usage.provider.tokens', { n: fmtCompact(m.tokens) })}` : ''}`;
    const section = (title, amount, rows) => rows.length ? h('div', { className: 'up-section' },
      h('div', { className: 'up-section-head' }, h('span', {}, title), h('strong', {}, amount)), rows) : null;
    const idleSection = (title, amount, rows) => rows.length ? h('details', { className: 'up-section up-idle' },
      h('summary', { className: 'up-section-head' }, h('span', {}, title), h('strong', {}, amount)), rows) : null;
    body.replaceChildren(...[
      section(t('usage.provider.paid'), money(p.paid), paid.map((m) => {
        const share = (m.paid / paidTotal) * 100;
        const fill = h('span', { className: 'is-paid' });
        fill.style.width = `${Math.max(2, share)}%`;
        return h('div', { className: 'uw' },
          h('div', { className: 'uw-top' }, h('span', { className: 'up-name', title: m.model }, m.model), h('span', { className: 'uw-pct' }, money(m.paid))),
          h('div', { className: 'uw-track' }, fill),
          m.price ? h('div', { className: 'uw-reset' }, t('usage.provider.price', { price: m.price })) : null,
          h('div', { className: 'uw-reset' }, `${t('usage.provider.share', { pct: share < 1 ? '<1' : Math.round(share), total: money(p.paid) })} · ${stats(m)}`));
      })),
      section(t('usage.provider.free'), fmtMoney(0, data.currency), free.map((m) => h('div', { className: 'uw' },
        h('div', { className: 'uw-top' }, h('span', { className: 'up-name', title: m.model }, m.model), h('span', { className: 'uw-pct' }, t('usage.provider.freeShort'))),
        h('div', { className: 'uw-reset' }, `${stats(m)} · ${t('usage.provider.freeHint')}`)))),
      section(t('usage.provider.plan'), t('usage.provider.planValue', { amount: money(p.planValue) }), plan.map((m) => h('div', { className: 'uw' },
        h('div', { className: 'uw-top' }, h('span', { className: 'up-name', title: m.model }, m.model), h('span', { className: 'uw-pct' }, t('usage.provider.planValue', { amount: money(m.value) }))),
        m.price ? h('div', { className: 'uw-reset' }, t('usage.provider.price', { price: m.price })) : null,
        h('div', { className: 'uw-reset' }, stats(m))))),
      idleSection(t('usage.provider.idle'), t('usage.provider.modelCount', { n: idle.length }), idle.map((m) => h('div', { className: 'uw' },
        h('div', { className: 'uw-top' }, h('span', { className: 'up-name', title: m.model }, m.model)),
        m.purpose ? h('div', { className: 'up-purpose' }, m.purpose) : null,
        m.price ? h('div', { className: 'uw-reset' }, t('usage.provider.price', { price: m.price })) : null))),
      h('div', { className: 'uw-reset', title: t('usage.provider.barHint') }, t('usage.provider.total', { n: fmtInt(p.requests), tokens: fmtCompact(p.tokens) })),
    ].filter(Boolean));
  };
  for (const [key, label] of [['today', t('usage.period.today')], ['month', t('usage.period.30days')]]) {
    tabs.append(h('button', { type: 'button', role: 'tab', className: 'up-tab tab', 'data-key': key, onclick: () => {
      periodKey = key;
      try { localStorage.setItem('hermes-web:usage-period', key); } catch { /* ignore */ }
      draw();
    } }, label));
  }
  draw();
  return [tabs, body];
}

// Shortest window first: 5-hour, weekly, monthly, then anything else.
const WINDOW_ORDER = [/5|hour/i, /week/i, /month/i];
const windowRank = (label) => { const i = WINDOW_ORDER.findIndex((re) => re.test(label)); return i === -1 ? WINDOW_ORDER.length : i; };

export function usageCard(data) {
  if (!data?.windows?.length && !data?.rows?.length && !data?.periods) return null;
  return h(
    'div',
    { className: 'usage-card', 'data-testid': 'provider-usage' },
    data.scope ? h('div', { className: 'uw-reset' }, data.scope) : null,
    (data.rows ?? []).map((r) => h('div', { className: 'up-balance' }, h('span', {}, r.label), h('strong', {}, r.value))),
    [...(data.windows ?? [])].sort((a, b) => windowRank(a.label) - windowRank(b.label)).map((w) => {
      const pct = Math.max(0, Math.min(100, w.usedPercent));
      const fill = h('span', { className: pct >= 90 ? 'level-danger' : pct >= 70 ? 'level-warn' : '' });
      fill.style.width = `${pct}%`;
      return h(
        'div',
        { className: 'uw' },
        h('div', { className: 'uw-top' }, h('span', {}, w.label), h('span', { className: 'uw-pct' }, `${Math.round(pct)}%`)),
        h('div', { className: 'uw-track', role: 'meter', 'aria-label': `${w.label} used`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct) }, fill),
        w.budget != null ? h('div', { className: 'uw-reset' }, t('usage.provider.budget', { used: fmtMoney(w.used, w.currency ?? data.currency), budget: fmtMoney(w.budget, w.currency ?? data.currency) })) : null,
        w.resetsAt ? h('div', { className: 'uw-reset' }, `Reset ${fmtDateTime(w.resetsAt)} (${fmtResetsIn(typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : w.resetsAt)})`) : null,
      );
    }),
    data.periods ? periodView(data) : null,
  );
}

// Account → Usage…: a dialog, so the account menu stays short. Cached data shows at once, a skeleton otherwise.
export function openUsage() {
  const agent = state.agent;
  if (!agent) return;
  const opener = document.activeElement;
  const body = h('div', { className: 'dlg-body' });
  const close = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('common.close'), onClick: () => shut() }, icon('x', 18));
  const refresh = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('usage.provider.reload'), title: t('usage.reload'), 'data-testid': 'usage-refresh', onClick: () => reload() }, icon('refresh', 18));
  const stamp = h('span', { className: 'up-stamp', 'aria-live': 'polite' });
  let view = 'balance';
  let lastData = null;
  const tabs = h('div', { className: 'dlg-tabs tabs tabs-box tabs-sm', role: 'tablist' }, [['balance', t('usage.tab.balance')], ['stats', t('usage.tab.stats')]].map(([key, label]) =>
    h('button', { type: 'button', role: 'tab', className: 'tab', 'data-key': key, 'data-testid': `usage-tab-${key}`, onclick: () => { view = key; paint(); } }, label)));
  const panel = h('div', { className: 'modal-box dlg-panel dlg-usage', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('usage.title'), 'data-testid': 'usage-dialog' },
    h('div', { className: 'dlg-head' }, h('h2', {}, t('usage.title')), stamp, h('span', { className: 'dlg-spacer' }), refresh, close), tabs, body);
  const overlay = h('div', { className: 'dlg modal modal-open' }, panel);
  const shut = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); opener?.focus?.(); };
  const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); shut(); } };
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) shut(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  close.focus();
  // Balance & plan = the provider's balance and quota; 30-day stats = tokens and cost of every chat of this agent.
  const paint = () => {
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.key === view));
    if (view === 'stats') { body.replaceChildren(agentUsageNode()); stamp.textContent = ''; } else if (lastData) show(lastData);
  };
  const show = (data) => {
    if (!overlay.isConnected) return;
    lastData = data;
    if (view !== 'balance') return;
    const card = usageCard(data);
    stamp.textContent = `${data?.name ? `${data.name} · ` : ''}${t('usage.provider.updated', { time: new Date(cache.get(agent)?.at ?? Date.now()).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })}`;
    body.replaceChildren(card ?? h('p', { className: 'dlg-note' }, t('usage.provider.empty')));
  };
  // Reloads in place: the old numbers stay visible (dimmed) until the new ones arrive.
  const reload = () => {
    if (view === 'stats') { body.replaceChildren(agentUsageNode()); return; }
    refresh.disabled = true;
    refresh.classList.add('is-spinning');
    body.classList.add('is-stale');
    loadProviderUsage({ force: true }).then(show).catch((err) => { stamp.textContent = t('usage.provider.failed', { message: err.message }); })
      .finally(() => { refresh.disabled = false; refresh.classList.remove('is-spinning'); body.classList.remove('is-stale'); });
  };
  tabs.children[0].setAttribute('aria-selected', 'true');
  const cached = peekProviderUsage();
  if (cached) {
    show(cached.data);
    if (Date.now() - cached.at >= TTL_MS) loadProviderUsage().then(show).catch(() => {});
  } else {
    body.replaceChildren(h('div', { className: 'usage-card is-loading', 'data-testid': 'provider-usage-loading' },
      [0, 1, 2].map(() => h('div', { className: 'uw' }, h('div', { className: 'skeleton uw-skel' }), h('div', { className: 'skeleton uw-skel' })))));
    loadProviderUsage().then(show).catch((err) => { if (overlay.isConnected) body.replaceChildren(h('p', { className: 'dlg-note' }, err.message)); });
  }
}
