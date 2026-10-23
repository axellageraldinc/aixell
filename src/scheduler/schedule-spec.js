// Schedule specs: {every:'30m'|'6h'|'45s'} | {at:['HH:MM'...], days?:[0-6]} | {cron:'m h dom mon dow'}.
// Wall-clock specs (at, cron) are read in an IANA time zone; `every` is a plain interval.

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const MAX_DAYS_AHEAD = 366 * 8;

export function parseEvery(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(String(text ?? '').trim());
  if (!m || !(Number(m[1]) > 0)) throw new Error(`schedule.every: invalid interval "${text}" (use e.g. "45s", "30m", "6h")`);
  return Math.round(Number(m[1]) * UNIT_MS[m[2]]);
}

function parseField(text, min, max, label) {
  const out = new Set();
  for (const part of String(text).split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`schedule.cron: invalid ${label} field "${text}"`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new Error(`schedule.cron: invalid step in ${label} field "${text}"`);
    let lo;
    let hi;
    if (m[1] === '*') { lo = min; hi = max; } else if (m[1].includes('-')) { [lo, hi] = m[1].split('-').map(Number); } else { lo = Number(m[1]); hi = m[2] === undefined ? lo : max; }
    if (lo < min || hi > max || lo > hi) throw new Error(`schedule.cron: ${label} out of range in "${text}" (${min}-${max})`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

function parseTime(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`schedule.at: invalid time "${text}" (use "HH:MM")`);
  return [Number(m[1]), Number(m[2])];
}

/** Validates a spec and returns a normalized form. Throws a clear Error when invalid. */
export function parseSpec(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('schedule: must be an object with exactly one of every, at, cron');
  const present = ['every', 'at', 'cron'].filter((k) => spec[k] !== undefined);
  if (present.length !== 1) throw new Error('schedule: must have exactly one of every, at, cron');
  if (present[0] === 'every') return { kind: 'every', ms: parseEvery(spec.every) };
  if (present[0] === 'at') {
    if (!Array.isArray(spec.at) || !spec.at.length) throw new Error('schedule.at: must be a non-empty array of "HH:MM" strings');
    const times = spec.at.map(parseTime);
    let days = null;
    if (spec.days !== undefined) {
      if (!Array.isArray(spec.days) || !spec.days.length || !spec.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error('schedule.days: must be an array of weekdays 0-6 (0 = Sunday)');
      days = new Set(spec.days);
    }
    return { kind: 'wall', times, days, dom: null, months: null, dowRestricted: Boolean(days), domRestricted: false };
  }
  if (typeof spec.cron !== 'string') throw new Error('schedule.cron: must be a string "m h dom mon dow"');
  const f = spec.cron.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`schedule.cron: expected 5 fields "m h dom mon dow", got ${f.length}`);
  const minutes = parseField(f[0], 0, 59, 'minute');
  const hours = parseField(f[1], 0, 23, 'hour');
  const dom = parseField(f[2], 1, 31, 'day-of-month');
  const months = parseField(f[3], 1, 12, 'month');
  const dow = parseField(f[4].replace(/\b7\b/g, '0'), 0, 6, 'day-of-week');
  const times = [];
  for (const h of hours) for (const mi of minutes) times.push([h, mi]);
  return { kind: 'wall', times, days: new Set(dow), dom: new Set(dom), months: new Set(months), dowRestricted: f[4] !== '*' && !/^\*\/1$/.test(f[4]), domRestricted: f[2] !== '*' && !/^\*\/1$/.test(f[2]) };
}

export const validateSpec = (spec) => { try { parseSpec(spec); return null; } catch (err) { return err.message; } };

const formatters = new Map();
function partsOf(ms, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}
// Offset (ms) of the zone at an instant: local wall clock read as UTC minus the instant.
function offsetAt(ms, tz) {
  const p = partsOf(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
// Epoch of a local wall time. A time inside a spring-forward gap lands just after the gap.
function wallToEpoch(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetAt(guess, tz);
  const off2 = offsetAt(t, tz);
  if (guess - off2 !== t) t = guess - off2;
  return t;
}

/** Next firing time (epoch ms) strictly after fromMs. */
export function nextDue(spec, fromMs, tz = 'UTC') {
  const s = parseSpec(spec);
  if (s.kind === 'every') return fromMs + s.ms;
  const start = partsOf(fromMs, tz);
  const base = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i < MAX_DAYS_AHEAD; i += 1) {
    const day = new Date(base + i * 86_400_000);
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const dow = day.getUTCDay();
    if (s.months && !s.months.has(mo)) continue;
    const domOk = !s.dom || s.dom.has(d);
    const dowOk = !s.days || s.days.has(dow);
    const dayOk = s.domRestricted && s.dowRestricted ? (domOk || dowOk) : (domOk && dowOk);
    if (!dayOk) continue;
    let best = Infinity;
    for (const [h, mi] of s.times) {
      const t = wallToEpoch(y, mo, d, h, mi, tz);
      if (t > fromMs && t < best) best = t;
    }
    if (best !== Infinity) return best;
  }
  throw new Error('schedule: no matching time within 8 years');
}

export function isValidZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
export const _localParts = partsOf;
