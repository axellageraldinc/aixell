// Sidebar session list: source switch, local search, date groups, rename/delete and "Load more".
import { h, $ } from './dom.js';
import { api, agentPath } from './api.js';
import { state, emit, on, runningSessionIds } from './state.js';
import { statusBlock, skeletonRows, notify } from './ui.js';
import { sessionRow, sessionTitle } from './session-row.js';
import { t } from './i18n.js';

const PAGE_SIZE = 50;
const DAY_MS = 86400000;
const listEl = $('#session-list');
const searchEl = $('#session-search');
let requestId = 0; // drops stale responses when agent changes mid-flight
let hits = { query: '', status: 'idle', results: [] }; // matches inside chat contents (server-side search)
let hitTimer = 0;
let hitId = 0;

// silent: refresh in place after a run, without skeleton flicker.
export async function loadSessions({ append = false, silent = false } = {}) {
  const agent = state.agent;
  if (!agent) return;
  const id = append ? requestId : ++requestId;
  const offset = append ? state.sessions.length : 0;
  const limit = silent ? Math.min(100, Math.max(PAGE_SIZE, state.sessions.length)) : PAGE_SIZE;
  if (!append && !silent) {
    state.sessions = [];
    listEl.setAttribute('aria-busy', 'true');
    listEl.replaceChildren(...skeletonRows(6));
  }
  try {
    const res = await api(`${agentPath(agent)}/sessions?${new URLSearchParams({ source: state.source, limit, offset })}`);
    if (id !== requestId || agent !== state.agent) return;
    state.sessions = append ? [...state.sessions, ...res.data] : res.data;
    state.sessionsHasMore = Boolean(res.has_more);
    render();
    emit('sessions:loaded');
  } catch (err) {
    if (id !== requestId) return;
    emit('sessions:failed');
    if (silent) return;
    listEl.replaceChildren(statusBlock({ kind: 'error', text: err.message, onRetry: () => loadSessions() }));
  } finally {
    if (id === requestId) listEl.removeAttribute('aria-busy');
  }
}

// Hermes names a chat a moment after its first reply ends, so the one reload at the end of the run can miss the
// title. Ask again a few times, with growing gaps, until the chat has one.
const TITLE_RETRY_MS = [1500, 3000, 5000, 8000, 12000, 20000];
const titleWatch = new Set();

async function watchTitle(sessionId) {
  const agent = state.agent;
  if (!sessionId || titleWatch.has(sessionId) || state.sessions.find((x) => x.id === sessionId)?.title) return;
  titleWatch.add(sessionId);
  try {
    for (const delay of TITLE_RETRY_MS) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (agent !== state.agent) return;
      await loadSessions({ silent: true });
      if (state.sessions.find((x) => x.id === sessionId)?.title) return;
    }
  } finally {
    titleWatch.delete(sessionId);
  }
}

// Chats are listed by when they were created, so an old chat does not jump to the top each time it gets a reply.
const createdAt = (s) => s.started_at ?? s.last_active ?? 0;

function groupLabel(epochSec, startOfToday) {
  const at = epochSec * 1000;
  if (at >= startOfToday) return t('sessions.group.today');
  if (at >= startOfToday - DAY_MS) return t('sessions.group.yesterday');
  if (at >= startOfToday - 7 * DAY_MS) return t('sessions.group.week');
  return t('sessions.group.older');
}

function render() {
  const query = searchEl.value.trim().toLowerCase();
  const visible = state.sessions
    .filter((s) => !query || sessionTitle(s).toLowerCase().includes(query))
    .sort((a, b) => createdAt(b) - createdAt(a));
  if (state.sessions.length === 0) {
    listEl.replaceChildren(statusBlock({ kind: 'empty', text: t('sessions.empty') }));
    return;
  }
  const contentSection = query.length >= 2 ? contentHits(query) : null;
  if (visible.length === 0) {
    listEl.replaceChildren(...(contentSection ? [contentSection] : [statusBlock({ kind: 'empty', text: t('sessions.noMatches') })]));
    return;
  }

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups = new Map();
  for (const s of visible) {
    const label = groupLabel(createdAt(s), startOfToday);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(sessionRow(s, s.id === state.sessionId, { onOpen, onRename: rename, onDelete: remove }));
  }
  const children = [...groups].map(([label, rows]) => h('div', { className: 'session-group', role: 'group', 'aria-label': label }, h('h3', {}, label), rows));
  if (state.sessionsHasMore) {
    children.push(h('button', { type: 'button', className: 'btn btn-sm btn-ghost load-more', onClick: () => loadSessions({ append: true }) }, t('sessions.loadMore')));
  }
  if (contentSection) children.push(contentSection);
  listEl.replaceChildren(...children);
  markRunning();
}

// "Inside messages": results of the server-side search over message text, shown under the title matches.
function snippetNode({ text, words }) {
  const lower = text.toLowerCase();
  const nodes = [];
  let at = 0;
  while (at < text.length) {
    let next = -1;
    let len = 0;
    for (const w of words) {
      const i = lower.indexOf(w, at);
      if (i !== -1 && (next === -1 || i < next)) { next = i; len = w.length; }
    }
    if (next === -1) { nodes.push(text.slice(at)); break; }
    if (next > at) nodes.push(text.slice(at, next));
    nodes.push(h('mark', {}, text.slice(next, next + len)));
    at = next + len;
  }
  return nodes;
}

function contentHits(query) {
  if (hits.query !== query || hits.status === 'loading') {
    return h('div', { className: 'session-group hits' }, h('h3', {}, t('sessions.search.inside')), h('p', { className: 'hit-note' }, t('sessions.search.searching')));
  }
  if (hits.status === 'error') return h('div', { className: 'session-group hits' }, h('h3', {}, t('sessions.search.inside')), h('p', { className: 'hit-note' }, t('sessions.search.failed')));
  if (!hits.results.length) return h('div', { className: 'session-group hits' }, h('h3', {}, t('sessions.search.inside')), h('p', { className: 'hit-note' }, t('sessions.search.noMatches')));
  const words = query.split(/\s+/).filter(Boolean);
  return h(
    'div',
    { className: 'session-group hits' },
    h('h3', {}, t('sessions.search.inside')),
    hits.results.map((r) =>
      h(
        'button',
        { type: 'button', className: 'hit-row', 'data-testid': 'search-hit', 'data-id': r.session_id, onClick: () => { state.findInChat = { id: r.session_id, words }; emit('session:select', r.session_id); } },
        h('span', { className: 'hit-title' }, h('span', { className: 'hit-name' }, r.title || t('sessions.untitled')), r.matches > 1 ? h('span', { className: 'hit-count' }, `${r.matches}×`) : null),
        h('span', { className: 'hit-snippet' }, snippetNode({ text: r.snippet.text, words })),
      ),
    ),
  );
}

function searchContent() {
  clearTimeout(hitTimer);
  const query = searchEl.value.trim().toLowerCase();
  if (query.length < 2) { hits = { query: '', status: 'idle', results: [] }; return; }
  const mine = ++hitId;
  hitTimer = setTimeout(async () => {
    hits = { query, status: 'loading', results: [] };
    render();
    try {
      const res = await api(`${agentPath(state.agent)}/search?${new URLSearchParams({ q: query, source: state.source })}`);
      if (mine !== hitId) return;
      hits = { query, status: 'done', results: res.results ?? [] };
    } catch {
      if (mine !== hitId) return;
      hits = { query, status: 'error', results: [] };
    }
    render();
  }, 300);
}

// Marks the rows of chats whose reply is still running (in this tab, on screen or not).
function markRunning() {
  const busy = runningSessionIds(state.agent);
  for (const row of listEl.querySelectorAll('.session-row')) row.classList.toggle('is-running', busy.has(row.dataset.id));
}

function markCurrent() {
  for (const row of listEl.querySelectorAll('.session-row')) {
    const open = row.querySelector('.session-open');
    if (row.dataset.id === state.sessionId) open?.setAttribute('aria-current', 'true');
    else open?.removeAttribute('aria-current');
  }
}

const onOpen = (s) => emit('session:select', s.id);

async function rename(s, title) {
  try {
    const { session } = await api(`${agentPath(state.agent)}/sessions/${encodeURIComponent(s.id)}`, { method: 'PATCH', body: { title } });
    state.sessions = state.sessions.map((x) => (x.id === s.id ? { ...x, ...session } : x));
    if (state.sessionId === s.id) state.session = { ...state.session, ...session };
    render();
    emit('session:changed');
  } catch (err) {
    notify(err.message);
    render();
  }
}

async function remove(s) {
  try {
    await api(`${agentPath(state.agent)}/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    state.sessions = state.sessions.filter((x) => x.id !== s.id);
    render();
    if (state.sessionId === s.id) emit('session:select', null);
  } catch (err) {
    notify(err.message);
  }
}

function newChat() {
  emit('session:select', null);
}

function focusSearch() {
  emit('sidebar:open');
  searchEl.focus();
  searchEl.select();
}

export function initSessions() {
  const clearBtn = $('#search-clear');
  searchEl.addEventListener('input', () => { clearBtn.hidden = searchEl.value === ''; searchContent(); render(); });
  clearBtn.addEventListener('click', () => { searchEl.value = ''; searchEl.dispatchEvent(new Event('input')); searchEl.focus(); });
  $('#session-new').addEventListener('click', newChat);
  $('#readonly-new').addEventListener('click', newChat);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      focusSearch();
    }
  });
  on('agent:select', () => loadSessions());
  on('sessions:reload', () => loadSessions({ silent: true }));
  on('title:watch', (sessionId) => watchTitle(sessionId));
  on('session:changed', markCurrent);
  on('run:state', markRunning);
}
