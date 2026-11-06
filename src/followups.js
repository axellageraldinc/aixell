// Follow-ups: the agent can promise to check in later, in the same chat. The agent calls the tools in src/followup-tools.js; this
// module keeps the list (data/followups.json), decides when one may be sent (quiet hours, daily limit, backing off when the owner
// does not answer) and asks the server to deliver it. It never reads or writes the agent's memory: the agent does that itself when
// the owner answers. Nothing here depends on what a follow-up is about.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.js';

export const CHECKIN_MARK = '[[aixell:checkin]]';
export const isCheckin = (text) => typeof text === 'string' && text.startsWith(CHECKIN_MARK);

const MIN_AHEAD_MS = 60_000;
const MAX_AHEAD_MS = 90 * 86_400_000;
const MAX_PENDING_PER_CHAT = 5;
const STALE_MS = 3 * 86_400_000; // a check-in that could not be sent for this long is dropped: it is probably out of date
const RETRY_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;
const KEEP_FINISHED = 100;
const BACK_OFF_AFTER = 2; // check-ins in a row that the owner did not answer

const clip = (value, max) => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max);
const sameConstant = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// The text the agent receives in place of a user message when a check-in is due. The mark lets the chat page hide it.
export function checkinSeed(item) {
  return `${CHECKIN_MARK}\nThis is an automatic check-in, not a message from the owner. Earlier in this chat you decided to follow up with them.\n`
    + `What you noted then: ${item.context}\nWhat you meant to find out: ${item.question}\n\n`
    + 'Write the check-in now: short, warm and natural, in the language and tone you have been using in this chat, and ask in your own words. '
    + 'Do not mention this note or that it was scheduled by a tool. When they answer, update your memory the way you normally would, and only schedule another follow-up if their answer gives a new reason.';
}

export function createFollowups({ dataDir, now = Date.now, settings, localMinutes, dayOf, deliver, isBusy = () => false, minAheadMs = MIN_AHEAD_MS, log = console }) {
  const file = path.join(dataDir, 'followups.json');
  const secretFile = path.join(dataDir, 'followups-secret');
  let secret = null;
  let items = [];
  try { items = JSON.parse(fs.readFileSync(file, 'utf8')).items ?? []; } catch { /* none yet */ }

  function persist() {
    const finished = items.filter((i) => i.status !== 'pending' && i.status !== 'sending');
    if (finished.length > KEEP_FINISHED) {
      const drop = new Set(finished.sort((a, b) => (a.sentAt ?? a.createdAt) - (b.sentAt ?? b.createdAt)).slice(0, finished.length - KEEP_FINISHED));
      items = items.filter((i) => !drop.has(i));
    }
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ items }), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  function secretValue() {
    if (secret) return secret;
    try { secret = fs.readFileSync(secretFile, 'utf8').trim(); } catch { secret = null; }
    if (!secret || secret.length < 32) {
      secret = crypto.randomBytes(32).toString('base64url');
      fs.writeFileSync(secretFile, secret, { mode: 0o600 });
    }
    return secret;
  }

  const enabled = () => Boolean(settings().enabled);
  const sign = (payload) => crypto.createHmac('sha256', secretValue()).update(payload).digest('base64url');

  // The key of a chat is derived, not stored: it names the chat and proves the server issued it.
  function keyFor(agent, sessionId) {
    const payload = Buffer.from(`${agent}\n${sessionId}`).toString('base64url');
    return `aixf_${payload}.${sign(payload)}`;
  }
  function chatOfKey(key) {
    const match = /^aixf_([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{20,})$/.exec(String(key ?? ''));
    if (!match || !sameConstant(match[2], sign(match[1]))) return null;
    const [agent, sessionId] = Buffer.from(match[1], 'base64url').toString().split('\n');
    return agent && sessionId ? { agent, sessionId } : null;
  }
  // The loopback caller proves itself with the same secret that the MCP server reads from the data directory.
  const authorizeToken = (header) => {
    const value = String(header ?? '');
    return value.startsWith('Bearer ') && sameConstant(value.slice(7), secretValue());
  };

  const fmt = (ms) => new Date(ms).toISOString();

  function create(chat, args) {
    if (!enabled()) throw new HttpError(404, 'Follow-ups are turned off.', 'followups_off');
    const dueAt = Date.parse(String(args.due_at ?? ''));
    if (!Number.isFinite(dueAt) || !/[zZ]|[+-]\d\d:?\d\d$/.test(String(args.due_at))) return { ok: false, message: 'due_at must be an ISO 8601 time with a UTC offset, e.g. 2026-03-04T09:30:00+07:00.' };
    if (dueAt < now() + minAheadMs) return { ok: false, message: 'due_at must be in the future.' };
    if (dueAt > now() + MAX_AHEAD_MS) return { ok: false, message: 'due_at is too far away (90 days at most).' };
    const context = clip(args.context, 1500);
    const question = clip(args.question, 300);
    if (!context || !question) return { ok: false, message: 'context and question are required.' };
    const mine = items.filter((i) => i.agent === chat.agent);
    const lastSent = mine.filter((i) => i.sentAt).sort((a, b) => b.sentAt - a.sentAt).slice(0, BACK_OFF_AFTER);
    if (lastSent.length === BACK_OFF_AFTER && lastSent.every((i) => i.status === 'sent')) {
      return { ok: false, message: `The owner has not answered your last ${BACK_OFF_AFTER} check-ins. Do not schedule another one unless they bring the topic up themselves. Do not mention this limit to them.` };
    }
    if (items.filter((i) => i.agent === chat.agent && i.sessionId === chat.sessionId && i.status === 'pending').length >= MAX_PENDING_PER_CHAT) {
      return { ok: false, message: `This chat already has ${MAX_PENDING_PER_CHAT} scheduled check-ins. Cancel one first.` };
    }
    const item = { id: crypto.randomBytes(5).toString('hex'), agent: chat.agent, sessionId: chat.sessionId, dueAt, context, question, status: 'pending', createdAt: now(), attempts: 0 };
    items.push(item);
    persist();
    return { ok: true, id: item.id, due_at: fmt(dueAt), message: 'Scheduled. Now tell the owner in your reply that you will check in with them and roughly when, and that they can tell you if it is not needed.' };
  }

  const view = (i) => ({ id: i.id, due_at: fmt(i.dueAt), question: i.question, context: i.context });
  const pendingOf = (chat) => items.filter((i) => i.agent === chat.agent && i.sessionId === chat.sessionId && i.status === 'pending');

  function cancel(chat, id) {
    const item = pendingOf(chat).find((i) => i.id === String(id));
    if (!item) return { ok: false, message: 'No scheduled check-in with that id in this chat.' };
    item.status = 'cancelled';
    persist();
    return { ok: true, message: 'Cancelled. Confirm to the owner that you will not check in on that.' };
  }

  // One entry point for the loopback route: a tool name, its arguments and the chat key.
  function call(tool, args, key) {
    const chat = chatOfKey(key);
    if (!chat) throw new HttpError(403, 'Invalid follow-up key.', 'bad_key');
    if (tool === 'schedule_followup') return create(chat, args ?? {});
    if (tool === 'list_followups') {
      if (!enabled()) throw new HttpError(404, 'Follow-ups are turned off.', 'followups_off');
      return { ok: true, followups: pendingOf(chat).map(view) };
    }
    if (tool === 'cancel_followup') return cancel(chat, args?.id);
    throw new HttpError(400, 'Unknown tool.', 'unknown_tool');
  }

  // The owner wrote in a chat: every check-in sent there counts as answered.
  function noteUserTurn(agent, sessionId) {
    let changed = false;
    for (const i of items) if (i.agent === agent && i.sessionId === sessionId && i.status === 'sent') { i.status = 'answered'; changed = true; }
    if (changed) persist();
  }

  function inQuietHours(ms) {
    const range = String(settings().quietHours ?? '');
    const match = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(range);
    if (!match) return false;
    const from = Number(match[1]) * 60 + Number(match[2]);
    const to = Number(match[3]) * 60 + Number(match[4]);
    if (from === to) return false;
    const minutes = localMinutes(ms);
    return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  }

  // Sends what is due. Called by the scheduler; never throws.
  async function tick() {
    if (!enabled()) return { sent: 0 };
    const t = now();
    let changed = false;
    for (const i of items) {
      if (i.status === 'pending' && t - i.dueAt > STALE_MS) { i.status = 'expired'; changed = true; }
    }
    if (changed) persist();
    if (inQuietHours(t)) return { sent: 0, quiet: true };
    const today = dayOf(t);
    let sentToday = items.filter((i) => i.sentAt && dayOf(i.sentAt) === today).length;
    const limit = settings().maxPerDay ?? 1;
    let sent = 0;
    const due = items.filter((i) => i.status === 'pending' && i.dueAt <= t).sort((a, b) => a.dueAt - b.dueAt);
    for (const item of due) {
      if (sentToday >= limit) break;
      if (isBusy(item.agent, item.sessionId)) continue;
      item.status = 'sending';
      persist();
      try {
        await deliver(item);
        item.status = 'sent';
        item.sentAt = now();
        sentToday += 1;
        sent += 1;
      } catch (error) {
        item.attempts += 1;
        item.status = item.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
        if (item.status === 'pending') item.dueAt = now() + RETRY_MS;
        log.warn?.(`[followups] ${item.id}: ${error.message}`);
      }
      persist();
    }
    return { sent };
  }

  // A check-in marked "sending" when the process stopped was probably not delivered: try it again.
  for (const i of items) if (i.status === 'sending') i.status = 'pending';

  return { enabled, keyFor, chatOfKey, authorizeToken, secretValue, call, noteUserTurn, tick, pendingOf, list: () => items.map((i) => ({ ...i })) };
}
