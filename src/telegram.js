import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { HttpError } from './http.js';

// Telegram chats live in the default Hermes profile's state.db. This reads them, read-only, so a chat can be
// looked at and continued from the web app. Nothing is ever written there.
let handle;
function db() {
  if (handle === undefined) {
    try {
      handle = new DatabaseSync(path.join(config.hermesRoot, 'state.db'), { readOnly: true });
      handle.exec('PRAGMA busy_timeout = 500');
    } catch {
      handle = null;
    }
  }
  return handle;
}

const ID_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_TRANSCRIPT_CHARS = 14_000;

export function listTelegramSessions(limit = 12) {
  try {
    return db()
      ?.prepare(
        `SELECT s.id, s.title, s.started_at, COALESCE(s.last_activity_at, s.started_at) AS last_active, s.message_count,
                (SELECT substr(m.content, 1, 120) FROM messages m WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL ORDER BY m.id LIMIT 1) AS preview
         FROM sessions s WHERE s.source = 'telegram' AND s.message_count > 0 AND s.hidden = 0 AND s.archived = 0
         ORDER BY last_active DESC LIMIT ?`,
      )
      .all(Math.min(Math.max(Number(limit) || 12, 1), 50)) ?? [];
  } catch {
    return [];
  }
}

// The words of one chat (user and agent text only; tool calls and results are left out), oldest first.
export function telegramMessages(id) {
  if (!ID_RE.test(id)) throw new HttpError(400, 'Bad session id.', 'bad_session');
  let session;
  let rows;
  try {
    session = db()?.prepare("SELECT id, title, started_at FROM sessions WHERE id = ? AND source = 'telegram'").get(id);
    rows = db()?.prepare("SELECT role, content, timestamp FROM messages WHERE session_id = ? AND role IN ('user', 'assistant') AND active = 1 AND content IS NOT NULL AND trim(content) != '' ORDER BY id").all(id);
  } catch {
    throw new HttpError(503, 'Telegram history cannot be read right now.', 'telegram_unavailable');
  }
  if (!session) throw new HttpError(404, 'Telegram chat not found.', 'not_found');
  return { session: { ...session }, messages: rows.map((r) => ({ role: r.role, content: r.content, timestamp: r.timestamp })) };
}

// Plain-text transcript for the "continue in the app" first message: the newest part that fits.
export function transcriptOf(messages) {
  const lines = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const who = messages[i].role === 'user' ? 'Me' : 'You';
    const line = `${who}: ${messages[i].content.trim()}`;
    if (total + line.length > MAX_TRANSCRIPT_CHARS) break;
    lines.unshift(line);
    total += line.length;
  }
  return lines.join('\n\n');
}
