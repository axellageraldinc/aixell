import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Hermes keeps the exact prompt size of a chat's latest model call in the session row (`model_config._usage_anchor`),
// which its HTTP API does not expose. It is read straight from the profile's state.db, read-only, and any problem
// (older Hermes, different schema, locked file) just means "unknown": the caller falls back to an estimate.
const handles = new Map();

function open(agent) {
  const file = path.join(agent.home, 'state.db');
  if (!handles.has(file)) {
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 500');
      handles.set(file, db);
    } catch {
      handles.set(file, null);
    }
  }
  return handles.get(file);
}

export function lastPromptTokens(agent, sessionId) {
  try {
    const row = open(agent)?.prepare('SELECT model_config FROM sessions WHERE id = ?').get(sessionId);
    const tokens = JSON.parse(row?.model_config || 'null')?._usage_anchor?.prompt_tokens;
    return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
  } catch {
    return null;
  }
}

// Full-text-ish search over the messages of a profile: every word must occur in the same message (case-insensitive).
// Read-only, like the rest of this file; any problem means "no results". Returns one entry per chat, newest first.
const SOURCE_OF = { web: 'api_server', telegram: 'telegram' };
const likeEscape = (word) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function snippetOf(content, words) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  const at = Math.max(0, lower.indexOf(words[0].toLowerCase()));
  const from = Math.max(0, at - 50);
  const slice = text.slice(from, from + 150);
  return { text: (from > 0 ? '…' : '') + slice + (from + 150 < text.length ? '…' : ''), words };
}

export function searchMessages(agent, query, { source = 'all', limit = 30 } = {}) {
  const words = [...new Set(String(query ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 0))].slice(0, 5);
  if (!words.length || words.join('').length < 2) return [];
  try {
    const db = open(agent);
    if (!db) return [];
    const where = ["m.role IN ('user', 'assistant')", 'm.active = 1', "m.content IS NOT NULL", ...words.map(() => "m.content LIKE ? ESCAPE '\\'")];
    const args = words.map(likeEscape);
    if (SOURCE_OF[source]) {
      where.push('s.source = ?');
      args.push(SOURCE_OF[source]);
    }
    const rows = db
      .prepare(
        `SELECT m.session_id, m.role, m.content, m.timestamp, s.title, s.source, s.started_at
         FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE ${where.join(' AND ')} ORDER BY m.timestamp DESC LIMIT 600`,
      )
      .all(...args);
    const bySession = new Map();
    for (const row of rows) {
      const hit = bySession.get(row.session_id);
      if (hit) {
        hit.matches += 1;
        continue;
      }
      if (bySession.size >= limit) continue;
      bySession.set(row.session_id, {
        session_id: row.session_id,
        title: row.title || null,
        source: row.source,
        started_at: row.started_at,
        role: row.role,
        timestamp: row.timestamp,
        snippet: snippetOf(row.content, words),
        matches: 1,
      });
    }
    return [...bySession.values()];
  } catch {
    return [];
  }
}
