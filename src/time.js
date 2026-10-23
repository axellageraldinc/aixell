// The deployment's clock: one time zone name from config.json (`timezone`, default UTC) used for
// day keys and for the quiet hours of notifications. Kept in one place so no module hard-codes a
// zone again.
import { config } from './config.js';

export const timezone = () => config.timezone || 'UTC';

// -> "YYYY-MM-DD" in the configured zone.
export const dayKey = (epochMs = Date.now()) => new Date(epochMs).toLocaleDateString('en-CA', { timeZone: timezone() });

// -> minutes since midnight in the configured zone.
export function minutesOfDay(epochMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone(), hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(epochMs));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return (hour % 24) * 60 + minute;
}
