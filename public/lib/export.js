// Export a chat: a Markdown file (every message, no tool output) or the browser's print dialog ("Save as PDF").
import { api, agentPath } from './api.js';
import { state, emit, on } from './state.js';
import { groupTurns } from './turns.js';
import { notify } from './ui.js';
import { fmtDateTime, agentLabel } from './format.js';
import { sessionTitle } from './session-row.js';
import { t } from './i18n.js';
import { APP_NAME } from './brand.js';

const PAGE = 500;

export async function allMessages(id) {
  const base = `${agentPath(state.agent)}/sessions/${encodeURIComponent(id)}/messages`;
  const rows = [];
  for (let offset = 0; offset < 50_000; offset += PAGE) {
    const page = await api(`${base}?${new URLSearchParams({ limit: PAGE, offset })}`);
    rows.push(...page.data);
    if (!(page.pagination?.has_more ?? page.data.length === PAGE)) break;
  }
  return rows;
}

// What the agent said in one turn: the words next to tool calls, then the final answer.
export function answerOf(turn) {
  const parts = [];
  for (const m of turn.items) {
    if (m.role !== 'assistant' || typeof m.content !== 'string' || !m.content.trim()) continue;
    parts.push(m.content.trim());
  }
  return parts.join('\n\n');
}

const stamp = (ts) => (ts ? ` · ${fmtDateTime(ts)}` : '');

export function toMarkdown(title, messages) {
  const lines = [`# ${title}`, '', `_${t('export.header', { app: APP_NAME, date: fmtDateTime(Date.now() / 1000) })}_`, ''];
  for (const turn of groupTurns(messages)) {
    if (turn.user?.content) lines.push('---', '', `**${t('export.you')}**${stamp(turn.user.timestamp)}`, '', String(turn.user.content).trim(), '');
    const answer = answerOf(turn);
    if (answer) lines.push('---', '', `**${agentLabel(state.agent)}**${stamp(turn.items[turn.items.length - 1]?.timestamp)}`, '', answer, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

const slug = (text) => text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat';

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function exportMarkdown(session) {
  try {
    const title = sessionTitle(session);
    const messages = await allMessages(session.id);
    if (!messages.length) return notify(t('export.error.empty'));
    download(`${slug(title)}.md`, toMarkdown(title, messages));
    notify(t('export.done'));
  } catch (err) {
    notify(err.message);
  }
}

// The page's print styles show the whole thread; this opens the chat first when it is not the one on screen.
export async function printChat(session) {
  if (state.sessionId !== session.id) {
    await new Promise((resolve) => {
      const stop = on('thread:rendered', () => { stop?.(); resolve(); });
      setTimeout(resolve, 6000);
      emit('session:select', session.id);
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  window.print();
}
