import * as store from './store.js';
import { CATEGORIES } from './feeds.js';
import { notifyFresh, subscriptionCount } from '../push.js';
import { minutesOfDay } from '../time.js';

// "Fresh: N new stories ready": one web push after a COMPLETE gathering cycle (every source fetched and nothing of that cycle left in the
// write queue) or a finished bootstrap, never for partial progress. What counts is the READY, not hidden cards since the last
// notification (or since the owner last opened Fresh, whichever is later). Guards, all in the Fresh settings:
//  - enabled; at least minNew cards (fewer accumulate into the next one); at least minIntervalH hours since the last one;
//  - quiet hours (in the configured time zone): what piles up overnight goes out as ONE push after they end, at the next completed cycle or the
//    5-minute check (tick) that follows;
//  - the owner opened Fresh in the last openSkipMin minutes: skipped, and the count starts again from that open.
// No push subscription, no push. The banner uses its own tag, so a new one replaces the previous Fresh banner.
export const NOTIFY_DEFAULTS = { enabled: true, minNew: 5, minIntervalH: 3, quiet: { on: true, from: '23:00', to: '07:00' }, openSkipMin: 30 };
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function normalizeNotify(input, base = NOTIFY_DEFAULTS) {
  const n = { ...base, quiet: { ...base.quiet } };
  const o = input && typeof input === 'object' ? input : {};
  if (typeof o.enabled === 'boolean') n.enabled = o.enabled;
  if (Number.isFinite(Number(o.minNew)) && o.minNew !== null && o.minNew !== '') n.minNew = Math.max(1, Math.min(50, Math.round(Number(o.minNew))));
  if (Number.isFinite(Number(o.minIntervalH)) && o.minIntervalH !== null && o.minIntervalH !== '') n.minIntervalH = Math.max(0, Math.min(24, Math.round(Number(o.minIntervalH) * 2) / 2));
  if (Number.isFinite(Number(o.openSkipMin)) && o.openSkipMin !== null && o.openSkipMin !== '') n.openSkipMin = Math.max(0, Math.min(240, Math.round(Number(o.openSkipMin))));
  if (o.quiet && typeof o.quiet === 'object') {
    if (typeof o.quiet.on === 'boolean') n.quiet.on = o.quiet.on;
    if (HM.test(o.quiet.from ?? '')) n.quiet.from = o.quiet.from;
    if (HM.test(o.quiet.to ?? '')) n.quiet.to = o.quiet.to;
  }
  return n;
}

const minutes = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
// Minutes since midnight in the configured time zone.
const localMinute = (t) => minutesOfDay(t);
export function inQuiet(quiet, t) {
  if (!quiet?.on) return false;
  const m = localMinute(t);
  const from = minutes(quiet.from);
  const to = minutes(quiet.to);
  if (from === to) return false;
  return from < to ? m >= from && m < to : m >= from || m < to;
}

// Hooks for tests: the clock, whether anybody is subscribed, and the sender.
let hooks = { now: () => Date.now(), subscribed: () => subscriptionCount() > 0, send: notifyFresh };
export const setHooks = (h) => { hooks = { ...hooks, ...h }; };

const KEY = 'notify-state';
const state = () => store.kvGet(KEY, null);
const save = (s) => store.kvSet(KEY, s);
// First start: only cards from now on count (the existing pool is not news).
export function init() {
  if (!state()) save({ since: hooks.now(), lastAt: 0, held: false });
}

export function notifyView(settings) {
  const s = state() ?? { since: 0, lastAt: 0, held: false };
  const since = Math.max(s.since, store.kvGet('last-open', 0));
  return { ...settings, lastAt: s.lastAt, held: Boolean(s.held), pending: store.readyByCat(since).reduce((n, r) => n + r.n, 0), subscribed: hooks.subscribed() };
}

export function message(rows) {
  const total = rows.reduce((n, r) => n + r.n, 0);
  const order = Object.keys(CATEGORIES);
  const top = [...rows].sort((a, b) => b.n - a.n || order.indexOf(a.cat) - order.indexOf(b.cat)).slice(0, 3).map((r) => `${CATEGORIES[r.cat] ?? r.cat} ${r.n}`);
  return { heading: `Fresh: ${total} new ${total === 1 ? 'story' : 'stories'} ready`, body: top.join(' · ') };
}

// opts.complete: the caller says the cycle (or bootstrap) finished completely. -> { sent, reason }
export async function maybeNotify(settings, { complete = false, why = 'cycle' } = {}) {
  const cfg = normalizeNotify(settings);
  if (!cfg.enabled) return { sent: false, reason: 'off' };
  if (!complete) return { sent: false, reason: 'partial' };
  init();
  const s = state();
  const now = hooks.now();
  if (!hooks.subscribed()) return { sent: false, reason: 'no subscription' };
  const lastOpen = store.kvGet('last-open', 0);
  // Whatever the owner saw when they opened Fresh is not news any more.
  if (lastOpen > s.since) { s.since = lastOpen; save(s); }
  if (cfg.openSkipMin > 0 && now - lastOpen < cfg.openSkipMin * 60_000) return { sent: false, reason: 'owner active' };
  const rows = store.readyByCat(s.since);
  const total = rows.reduce((n, r) => n + r.n, 0);
  if (total < cfg.minNew) { if (s.held) { s.held = false; save(s); } return { sent: false, reason: 'too few', total }; }
  if (inQuiet(cfg.quiet, now)) { s.held = true; save(s); return { sent: false, reason: 'quiet hours', total }; }
  if (s.lastAt && now - s.lastAt < cfg.minIntervalH * 3_600_000) { s.held = true; save(s); return { sent: false, reason: 'interval', total }; }
  const text = message(rows);
  let devices = 0;
  try { devices = await hooks.send({ ...text, url: '/#/home', tag: 'aixell-fresh' }); } catch (err) { console.warn(`[fresh] push failed: ${err.message}`); return { sent: false, reason: 'send failed', total }; }
  save({ since: now, lastAt: now, held: false });
  return { sent: true, reason: why, total, devices, ...text };
}

// Every few minutes: a notification that was held back (quiet hours, interval) goes out as soon as it may, when no cycle is running
// and the write queue has nothing left. `idle` is the caller's word that nothing is gathering.
export async function tick(settings, { idle = true } = {}) {
  const s = state();
  if (!s?.held || !idle) return { sent: false, reason: 'nothing held' };
  return maybeNotify(settings, { complete: true, why: 'held' });
}
