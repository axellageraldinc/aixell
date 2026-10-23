// Warns above the thread when a plan window (weekly / monthly) is nearly used up. Dismissing hides that window at that
// level until its reset; crossing the next level brings the warning back.
import { $ } from './dom.js';
import { on, state } from './state.js';
import { fmtMoney, fmtDateTime } from './format.js';
import { t } from './i18n.js';

const LEVELS = [95, 80];
const CHECK_EVERY_MS = 5 * 60_000;
const DISMISS_KEY = 'hermes-web:quota-dismissed';
const banner = $('#quota-banner');

const readDismissed = () => { try { return JSON.parse(localStorage.getItem(DISMISS_KEY)) || {}; } catch { return {}; } };
const writeDismissed = (value) => { try { localStorage.setItem(DISMISS_KEY, JSON.stringify(value)); } catch { /* per-page only */ } };

// The most urgent window that has not been dismissed at its current level.
export function pickWarning(windows, dismissed = {}) {
  const found = [];
  for (const w of windows ?? []) {
    const level = LEVELS.find((l) => w.usedPercent >= l);
    if (!level) continue;
    const key = `${state.agent}|${w.label}|${w.resetsAt ?? ''}`;
    if (dismissed[key] >= level) continue;
    found.push({ w, level, key });
  }
  return found.sort((a, b) => b.w.usedPercent - a.w.usedPercent)[0] ?? null;
}

function render(data) {
  const warning = pickWarning(data?.windows, readDismissed());
  if (!warning) { banner.hidden = true; return; }
  const { w, level, key } = warning;
  const money = w.budget != null ? ` (${t('usage.provider.budget', { used: fmtMoney(w.used, w.currency ?? data.currency), budget: fmtMoney(w.budget, w.currency ?? data.currency) })})` : '';
  const reset = w.resetsAt ? ` ${t('usage.reset', { time: fmtDateTime(w.resetsAt) })}` : '';
  banner.dataset.level = level >= 95 ? 'danger' : 'warn';
  banner.replaceChildren();
  const text = document.createElement('button');
  text.type = 'button';
  text.className = 'quota-text';
  text.textContent = t('usage.quota.banner', { label: w.label.toLowerCase(), pct: Math.round(w.usedPercent), money, reset });
  text.addEventListener('click', () => import('./provider-usage.js').then((m) => m.openUsage()));
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ibtn quota-close';
  close.setAttribute('aria-label', t('usage.quota.dismiss'));
  close.textContent = '×';
  close.addEventListener('click', () => { writeDismissed({ ...readDismissed(), [key]: level }); banner.hidden = true; });
  banner.append(text, close);
  banner.hidden = false;
}

let checking = false;
async function check() {
  if (checking || !state.agent || document.visibilityState !== 'visible') return;
  checking = true;
  try { render(await (await import('./provider-usage.js')).loadProviderUsage()); } catch { /* the usage panel reports errors itself */ } finally { checking = false; }
}

export function initQuotaBanner() {
  on('agent:select', check);
  on('run:concluded', () => setTimeout(check, 2000));
  document.addEventListener('visibilitychange', check);
  setInterval(check, CHECK_EVERY_MS);
}
