// The shared cost ledger of the metered connectors.
//
// It keeps the exact file and format the X search code used before connectors
// (`<dataDir>/fresh-x.json`), so a deployment keeps its day's spend across the upgrade:
//
//   { "days": { "YYYY-MM-DD": { "calls": 1, "costMicro": 100000000, "slots": { "1": {...} } } },
//     "last": { "<slot type>": "YYYY-MM-DD" }, "blockedUntil": 0 }
//
// Day boundaries come from the connector context's time zone, not from a fixed offset. A call is
// reserved BEFORE it is made (`reserve`), so a crash cannot overspend; the actual price is added
// after the answer (`settle`) and a refused call gives its reservation back (`refund`).
//
//   const budget = createBudget({ file, timezone: 'UTC' })
//   budget.reserve(costMicro, { cap: 7 })  -> false when today's cap is reached
//   budget.settle(costMicro)
//   budget.spentToday() -> { day, calls, costMicro, slots }
//
// Writes are atomic (a temporary file next to the ledger, then a rename) and the file stays 0600.
// Only the last 70 days are kept (a month of cost needs 31).
import fs from 'node:fs';
import path from 'node:path';

const KEEP_DAYS = 70;

// "YYYY-MM-DD" in the given IANA zone.
export function dayOf(epochMs, timezone = 'UTC') {
  try {
    return new Date(epochMs).toLocaleDateString('en-CA', { timeZone: timezone || 'UTC' });
  } catch {
    return new Date(epochMs).toLocaleDateString('en-CA', { timeZone: 'UTC' });
  }
}

const emptyLedger = () => ({ days: {}, last: {} });

export function createBudget({ file, timezone = 'UTC', now = Date.now } = {}) {
  if (!file) throw new Error('budget: a ledger file is required');

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? { ...emptyLedger(), ...parsed } : emptyLedger();
    } catch {
      return emptyLedger();
    }
  }

  function write(ledger) {
    const next = ledger && typeof ledger === 'object' ? ledger : emptyLedger();
    const keep = Object.keys(next.days ?? {}).sort().slice(-KEEP_DAYS);
    next.days = Object.fromEntries(keep.map((key) => [key, next.days[key]]));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    return next;
  }

  function update(fn) {
    const ledger = read();
    const result = fn(ledger);
    write(ledger);
    return result;
  }

  const rowOf = (ledger, day) => (ledger.days[day] ??= { calls: 0, costMicro: 0, slots: {} });

  // One call, recorded before it is made. `cap` is the day's maximum number of calls (null or
  // Infinity means no cap). `costMicro` is the price the caller expects to pay: it is not added to
  // the day's spend (that is settle(), with the real price from the answer), it only lets a caller
  // enforce a cost ceiling as well.
  function reserve(costMicro = 0, { cap = null, maxCostMicro = null, at = now() } = {}) {
    const day = dayOf(at, timezone);
    return update((ledger) => {
      const row = rowOf(ledger, day);
      if (Number.isFinite(cap) && row.calls >= cap) return false;
      if (Number.isFinite(maxCostMicro) && row.costMicro + Math.max(0, Number(costMicro) || 0) > maxCostMicro) return false;
      row.calls += 1;
      return true;
    });
  }

  // The actual price of a call that answered. The call itself was already counted by reserve().
  function settle(costMicro = 0, { at = now() } = {}) {
    const cost = Math.max(0, Number(costMicro) || 0);
    if (!cost) return;
    const day = dayOf(at, timezone);
    update((ledger) => { rowOf(ledger, day).costMicro += cost; });
  }

  // A call that was refused (402/429/5xx/no key) never happened.
  function refund(costMicro = 0, { at = now() } = {}) {
    const cost = Math.max(0, Number(costMicro) || 0);
    const day = dayOf(at, timezone);
    update((ledger) => {
      const row = rowOf(ledger, day);
      row.calls = Math.max(0, row.calls - 1);
      row.costMicro = Math.max(0, row.costMicro - cost);
    });
  }

  // The state of one slot of the day (pending/done/skipped/... and its counts), kept in the same
  // `days.<day>.slots` map the pre-connector ledger used.
  function markSlot(slotN, patch = {}, at = now()) {
    const day = dayOf(at, timezone);
    update((ledger) => {
      const row = rowOf(ledger, day);
      row.slots ??= {};
      row.slots[slotN] = { ...(row.slots[slotN] ?? {}), ...patch };
    });
  }

  function spentToday(at = now()) {
    const day = dayOf(at, timezone);
    const ledger = read();
    const row = ledger.days?.[day] ?? { calls: 0, costMicro: 0, slots: {} };
    return { day, calls: row.calls ?? 0, costMicro: row.costMicro ?? 0, slots: row.slots ?? {} };
  }

  return {
    file,
    timezone,
    read,
    write,
    update,
    reserve,
    settle,
    refund,
    markSlot,
    spentToday,
    dayOf: (at = now()) => dayOf(at, timezone),
  };
}
