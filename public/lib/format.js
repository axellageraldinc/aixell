// Number and date formatting. Unknown values (null/undefined) always render as a dash: never guess numbers.

const DASH = '—';

const full = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const fmtInt = (n) => (n == null ? DASH : full.format(n));
export const fmtCompact = (n) => (n == null ? DASH : compact.format(n));

export function fmtUsd(n, maxDigits = 4) {
  if (n == null) return DASH;
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: Math.min(2, maxDigits), maximumFractionDigits: maxDigits });
}

// Amount in the currency the provider bills in (provider data, default USD). Other currencies are formatted by Intl, with
// whole units for large amounts and one decimal for small ones.
export function fmtMoney(n, currency = 'USD', maxDigits = 4) {
  if (n == null) return DASH;
  if (!currency || currency === 'USD') return fmtUsd(n, maxDigits);
  const digits = Math.abs(n) < 100 ? 1 : 0;
  try {
    return Number(n).toLocaleString('en-US', { style: 'currency', currency, currencyDisplay: 'code', minimumFractionDigits: 0, maximumFractionDigits: digits });
  } catch { return `${Number(n).toLocaleString('en-US', { maximumFractionDigits: digits })} ${currency}`; }
}

// "17 Oct, 14:02"
export function fmtDateTime(epochSec) {
  if (epochSec == null) return DASH;
  return new Date(epochSec * 1000).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// "YYYY-MM-DD" -> "17 Oct"
export function fmtDay(isoDate) {
  const [year, month, day] = String(isoDate).split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function fmtBytes(n) {
  if (n == null) return DASH;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// Agent names are shown as they come from the agent list: the app does not invent display names.
export function agentLabel(agentOrName) {
  const name = typeof agentOrName === 'string' ? agentOrName : agentOrName?.name;
  return name ?? 'Agent';
}

// Elapsed time: "0.4s", "12.8s", "2m 05s". Unknown stays a dash.
export function fmtDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return DASH;
  const s = Math.max(0, seconds);
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const minutes = Math.floor(s / 60);
  return `${minutes}m ${String(Math.round(s - minutes * 60)).padStart(2, '0')}s`;
}

// "in 4h 12m" / "in 2d 3h" until an ISO timestamp.
export function fmtResetsIn(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return DASH;
  if (ms <= 0) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// Counter for something still running: whole seconds only ("7s", "2m 05s").
export function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// "5 minutes ago", "yesterday", "3 days ago"; compact: "5m ago", "3d ago". Empty for a missing timestamp.
const relLong = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const relShort = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' });
export function fmtAgo(epochSec, { compact = false } = {}) {
  if (!epochSec) return '';
  const format = compact ? relShort : relLong;
  const seconds = Math.max(0, Date.now() / 1000 - epochSec);
  if (seconds < 45) return format.format(0, 'second');
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), 'minute');
  if (seconds < 86_400) return format.format(-Math.round(seconds / 3600), 'hour');
  if (seconds < 604_800) return format.format(-Math.round(seconds / 86_400), 'day');
  if (seconds < 2_629_800) return format.format(-Math.round(seconds / 604_800), 'week');
  return format.format(-Math.round(seconds / 2_629_800), 'month');
}
