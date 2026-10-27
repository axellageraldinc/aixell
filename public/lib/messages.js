// Message thread: history loading, the empty "new chat" line, and the nodes of a reply that is still running.
// The thread is always drawn from the loaded message list; a running reply is appended after it as live nodes.
// A reply keeps streaming while another chat is open, so live nodes are kept per chat and only the chat that is
// on screen is drawn.
import { icon } from './icons.js';
import { h, $ } from './dom.js';
import { api, agentPath } from './api.js';
import { state, emit, on, sessionKey, saveLastSession, liveRun } from './state.js';
import { statusBlock, skeletonRows, notify } from './ui.js';
import { userNode } from './message-nodes.js';
import { hydrateOpenUI } from './markdown.js';
import { afterPaint } from './paint.js';
import { groupTurns, turnNodes } from './turns.js';
import { scrollToEnd, threadScroller } from './scroll.js';
import { resetNewChatSettings, effectiveModelId, seedSettings, seedContext, findModel, noteLiveSeed, loadServedModel } from './models.js';
import { sessionTitle } from './session-row.js';
import { currentAgent } from './agents.js';
import { agentLabel, fmtCompact, fmtDateTime } from './format.js';
import { t } from './i18n.js';

const PAGE_SIZE = 100;
const SETTLE_FIRST_LIMIT = 30;
const listEl = $('#message-list');
const mainEl = $('#main');
// A new, empty chat is laid out as a welcome screen with the composer in the middle.
const extrasEl = $('#new-extras');
const setNewMode = (on) => {
  mainEl.classList.toggle('is-new', on);
  extrasEl.hidden = !on;
  if (on) extrasEl.replaceChildren(...[startersNode(), recentNode()].filter(Boolean));
};
let loadId = 0;
let store = []; // loaded messages, oldest first
let hasOlder = false;
let cutoff = null; // seconds: messages from this moment on are drawn live instead

// Live nodes of the replies in flight, keyed like state.runs: { user: [node], parts: [node] }.
const liveByKey = new Map();

const visibleKey = () => sessionKey(state.agent, state.sessionId);
const nodesOf = (key) => {
  const entry = liveByKey.get(key);
  return entry ? [...entry.user, ...entry.parts] : [];
};

function bucket(key) {
  let entry = liveByKey.get(key);
  if (!entry) {
    entry = { user: [], parts: [] };
    liveByKey.set(key, entry);
  }
  return entry;
}

function clearEmptyState() {
  listEl.querySelectorAll(':scope > .hero, :scope > .status').forEach((el) => el.remove());
  setNewMode(false);
}

// Appends a node of a running reply to its chat; only the chat on screen reaches the DOM.
export function addLive(key, node, { user = false } = {}) {
  (user ? bucket(key).user : bucket(key).parts).push(node);
  if (key !== visibleKey()) return;
  clearEmptyState();
  listEl.append(node);
  if (user) scrollToEnd(true);
  else scrollToEnd();
}

export function removeLive(key, node) {
  const entry = liveByKey.get(key);
  if (entry) {
    for (const list of [entry.user, entry.parts]) {
      const index = list.indexOf(node);
      if (index !== -1) list.splice(index, 1);
    }
    if (!entry.user.length && !entry.parts.length) liveByKey.delete(key);
  }
  node.remove();
}

// Drops every live node of a chat: the stored history takes over.
export function dropLive(key) {
  for (const node of nodesOf(key)) node.remove();
  liveByKey.delete(key);
}

// A stored turn already carries its user message, so the live copy is only needed while the chat stays open.
export function dropLiveUser(key) {
  const entry = liveByKey.get(key);
  if (!entry?.user.length) return;
  for (const node of entry.user) node.remove();
  entry.user.length = 0;
  if (!entry.parts.length) liveByKey.delete(key);
}

// A new chat becomes a real session mid-run: its live nodes follow the new key.
export function rekeyLive(from, to) {
  const entry = liveByKey.get(from);
  if (!entry) return;
  liveByKey.delete(from);
  liveByKey.set(to, entry);
}

// A reply running on the server is drawn live, but its user message is already stored: show that one from history
// (it carries the attachment markers) and hide only what the agent did after it.
function visibleMessages() {
  if (cutoff == null) return store;
  const turnUser = store.find((m) => m.role === 'user' && (m.timestamp ?? 0) >= cutoff);
  return store.filter((m) => (m.timestamp ?? 0) < cutoff || m === turnUser);
}

// After a run the server has the final title and counters: refresh the open session.
async function refreshSession(retried = false) {
  const id = state.sessionId;
  if (!id || liveRun(state.agent, id)) return;
  try {
    const { session } = await api(`${agentPath(state.agent)}/sessions/${encodeURIComponent(id)}`);
    if (id !== state.sessionId || liveRun(state.agent, id)) return;
    state.session = session;
    seedContext(state.agent, session);
    emit('session:changed');
    // Hermes stores the exact prompt size slightly after the run ends: look once more if it is not there yet.
    if (session.web_context?.approx && !retried) setTimeout(() => refreshSession(true), 2500);
  } catch {
    // Keep showing the old numbers; a failed refresh must not disturb the chat.
  }
}

// While a reply is running the context meter follows it: the server's figure moves with every model call, so it is read
// after each step (tool or answer) and every few seconds. Only the numbers are taken, nothing on screen is rebuilt.
const LIVE_MIN_GAP_MS = 2000;
let lastLiveRead = 0;
async function refreshLiveContext() {
  const id = state.sessionId;
  if (!id || document.visibilityState !== 'visible' || !liveRun(state.agent, id) || Date.now() - lastLiveRead < LIVE_MIN_GAP_MS) return;
  lastLiveRead = Date.now();
  try {
    const { session } = await api(`${agentPath(state.agent)}/sessions/${encodeURIComponent(id)}`);
    if (id !== state.sessionId || !liveRun(state.agent, id)) return;
    seedContext(state.agent, session);
    if (session.web_context && !session.web_context.approx) noteLiveSeed(sessionKey(state.agent, id));
    if (state.session) state.session = { ...state.session, web_cost: session.web_cost, input_tokens: session.input_tokens, output_tokens: session.output_tokens, api_call_count: session.api_call_count };
    emit('context:changed');
  } catch {
    // The meter keeps its last value; the next step tries again.
  }
}

export function initMessages() {
  on('run:step', refreshLiveContext);
  setInterval(refreshLiveContext, 6000);
  on('session:select', loadSession);
  on('usage:changed', () => refreshSession());
  // Hermes writes the run's final prompt size a moment after the run ends: look again a few times so the meter
  // catches up by itself instead of waiting for a reload.
  on('run:concluded', ({ key } = {}) => {
    if (key !== visibleKey()) return;
    for (const delay of [1500, 4000, 9000]) setTimeout(() => { if (key === visibleKey()) refreshSession(); }, delay);
  });
  for (const type of ['models:changed', 'settings:changed', 'agent:status', 'sessions:loaded']) on(type, refreshHero);
}

// Welcome screen of an empty chat: just a greeting; the model lives in the composer.
function greeting() {
  const hour = new Date().getHours();
  if (hour < 4) return t('chat.greeting.night');
  if (hour < 11) return t('chat.greeting.morning');
  if (hour < 15) return t('chat.greeting.midday');
  if (hour < 19) return t('chat.greeting.evening');
  return t('chat.greeting.nightLate');
}

function heroNode() {
  return h(
    'div',
    { className: 'hero', 'data-testid': 'new-chat' },
    h('img', { className: 'hero-logo', src: '/favicon.svg', alt: '', width: 52, height: 52 }),
    h('h2', {}, greeting()),
    h('p', { className: 'hero-sub' }, t('chat.hero.subtitle')),
  );
}

// Starter cards: they fill the composer with the start of a request, so the rest is quick to finish.
const STARTERS = [
  { icon: 'pencil', title: t('chat.starter.write.title'), text: t('chat.starter.write.text') },
  { icon: 'search', title: t('chat.starter.explain.title'), text: t('chat.starter.explain.text') },
  { icon: 'copy', title: t('chat.starter.summarise.title'), text: t('chat.starter.summarise.text') },
  { icon: 'plus', title: t('chat.starter.translate.title'), text: t('chat.starter.translate.text') },
];

function startersNode() {
  const input = document.querySelector('#composer-input');
  return h(
    'div',
    { className: 'starters', 'aria-label': t('chat.starters.label') },
    STARTERS.map((st) =>
      h('button', { type: 'button', className: 'starter', 'data-testid': 'starter', onClick: () => {
        input.value = st.text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      } }, icon(st.icon, 16), h('span', {}, st.title)),
    ),
  );
}

// Recent chats as suggestion pills under the composer of the welcome screen.
function recentNode() {
  const recent = state.sessions.filter((s) => s.source !== 'telegram').slice(0, 6);
  if (!recent.length) return null;
  return h(
    'div',
    { className: 'pills', 'aria-label': t('sessions.recent') },
    recent.map((s) => h('button', { type: 'button', className: 'pill', 'data-testid': 'recent-chat', title: fmtDateTime(s.last_active ?? s.started_at), onClick: () => emit('session:select', s.id) }, sessionTitle(s))),
  );
}

function refreshHero() {
  const hero = listEl.querySelector(':scope > .hero');
  if (hero) hero.replaceWith(heroNode());
  if (mainEl.classList.contains('is-new')) extrasEl.replaceChildren(...[startersNode(), recentNode()].filter(Boolean));
}

function resetThread() {
  store = [];
  hasOlder = false;
  cutoff = null;
}

export function showNewChat() {
  resetThread();
  const live = nodesOf(visibleKey());
  setNewMode(live.length === 0);
  listEl.replaceChildren(...(live.length ? [] : [heroNode()]), ...live);
}

function renderThread() {
  setNewMode(false);
  const visible = visibleMessages();
  const live = nodesOf(visibleKey());
  const nodes = [];
  if (hasOlder) nodes.push(olderButton());
  for (const turn of groupTurns(visible)) nodes.push(...turnNodes(turn));
  if (nodes.length === 0 && live.length === 0) nodes.push(statusBlock({ kind: 'empty', text: t('chat.empty') }));
  listEl.replaceChildren(...nodes, ...live);
  // A stored reply can carry a visual block: it can only be mounted once the thread is in the document.
  afterPaint(() => hydrateOpenUI(listEl));
  emit('thread:rendered');
}

// attachments: [{ id, name, kind }] just uploaded from the composer.
export function appendUserMessage(key, text, attachments = []) {
  const node = userNode(text, null, attachments);
  addLive(key, node, { user: true });
  return node;
}

const newestQuery = () => new URLSearchParams({ limit: PAGE_SIZE, offset: 0, order: 'desc' });

function mergeMessages(rows) {
  const byId = new Map(store.map((m) => [m.id, m]));
  for (const m of rows) byId.set(m.id, m);
  store = [...byId.values()].sort((a, b) => a.id - b.id);
}

// After a run: swap the live nodes for what the server stored (reasoning, tool output and timing included).
// Returns false when the server does not have the finished turn, so the live nodes stay.
export async function settleRun(sessionId, sinceSeconds) {
  // A chat that is not on screen keeps nothing: opening it again loads the stored turn.
  if (sessionId !== state.sessionId) return false;
  const id = sessionId;
  const token = loadId;
  // Ask for a small page first; only widen it when the turn is longer than that.
  let limit = SETTLE_FIRST_LIMIT;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const base = `${agentPath(state.agent)}/sessions/${encodeURIComponent(id)}`;
      const page = await api(`${base}/messages?${new URLSearchParams({ limit, offset: 0, order: 'desc' })}`);
      if (token !== loadId || id !== state.sessionId) return false;
      const wasEmpty = store.length === 0;
      const known = new Set(store.map((m) => m.id));
      const touches = wasEmpty || page.data.some((m) => known.has(m.id));
      mergeMessages(page.data);
      if (wasEmpty) hasOlder = hasMore(page);
      const last = store[store.length - 1];
      const turnSaved = store.some((m) => m.role === 'user' && (m.timestamp ?? 0) >= sinceSeconds - 0.5);
      const answered = last && last.role === 'assistant' && !(last.tool_calls?.length);
      // The page must reach back to messages we already hold, or the thread would have a hole in it.
      if ((!turnSaved || !touches) && hasMore(page) && limit < 400) {
        limit = Math.min(limit * 3, 400);
        continue;
      }
      if (turnSaved && answered) {
        cutoff = null;
        dropLive(visibleKey());
        renderThread();
        scrollToEnd();
        return true;
      }
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return false;
}

// id === null starts a new chat.
export async function loadSession(id) {
  const token = ++loadId;
  const previousKey = visibleKey();
  const previousRun = liveRun(state.agent, state.sessionId);
  // Leaving a chat drops its live nodes. A chat with a reply still running keeps them (that run keeps streaming
  // in the background); only the live user message goes, since the stored turn already holds one.
  if (previousRun) dropLiveUser(previousKey);
  else dropLive(previousKey);
  state.sessionId = id ?? null;
  state.session = null;
  saveLastSession(state.agent, id);
  if (!id) {
    resetNewChatSettings();
    emit('chat:reset');
  }
  emit('session:changed');
  if (!id) {
    showNewChat();
    emit('composer:focus');
    return;
  }

  resetThread();
  setNewMode(false);
  listEl.replaceChildren(...skeletonRows(3, 'skeleton-message'));
  try {
    const base = `${agentPath(state.agent)}/sessions/${encodeURIComponent(id)}`;
    const [{ session }, page] = await Promise.all([api(base), api(`${base}/messages?${newestQuery()}`)]);
    if (token !== loadId) return;

    state.session = session;
    seedSettings(state.agent, session);
    seedContext(state.agent, session);
    // A routed gateway pins one model per conversation: reopening a chat asks which one (a reload keeps the name).
    loadServedModel(id);
    store = page.data;
    hasOlder = hasMore(page);
    // A chat that ended in a long run of tool calls has no words in its newest messages: read further back (up to
    // 5 more pages) until there is a question and a reply to show, so a chat never opens empty.
    const words = (m) => typeof m.content === 'string' && m.content.trim() !== '';
    for (let more = 0; more < 5 && hasOlder && !(store.some((m) => m.role === 'user' && words(m)) && store.some((m) => m.role === 'assistant' && words(m))); more += 1) {
      const next = await api(`${base}/messages?${new URLSearchParams({ limit: PAGE_SIZE, offset: store.length, order: 'desc' })}`);
      if (token !== loadId) return;
      mergeMessages(next.data);
      hasOlder = hasMore(next);
    }
    // A reply still running on the server is drawn live (replayed), so its stored messages are left out here.
    if (session.web_run) cutoff = session.web_run.startedAt / 1000;
    renderThread();
    emit('session:changed');
    scrollToEnd(true);
    emit('thread:opened');
    if (session.web_run) emit('run:resume', { sessionId: id, startedAt: session.web_run.startedAt, userShown: visibleMessages().some((m) => m.role === 'user' && (m.timestamp ?? 0) >= cutoff) });
    else emit('composer:focus');
  } catch (err) {
    if (token !== loadId) return;
    if (err.status === 404) {
      saveLastSession(state.agent, null);
      emit('session:select', null);
      return;
    }
    listEl.replaceChildren(statusBlock({ kind: 'error', text: err.message, onRetry: () => loadSession(id) }));
  }
}

const hasMore = (page) => page.pagination?.has_more ?? page.data.length === PAGE_SIZE;

function olderButton() {
  return h('button', { type: 'button', className: 'btn btn-sm btn-ghost older', onClick: loadOlder }, t('chat.loadEarlier'));
}

async function loadOlder(event) {
  const button = event.currentTarget;
  const token = loadId;
  button.disabled = true;
  try {
    const base = `${agentPath(state.agent)}/sessions/${encodeURIComponent(state.sessionId)}`;
    const query = new URLSearchParams({ limit: PAGE_SIZE, offset: store.length, order: 'desc' });
    const page = await api(`${base}/messages?${query}`);
    if (token !== loadId) return;
    const anchor = threadScroller.scrollHeight;
    mergeMessages(page.data);
    hasOlder = hasMore(page);
    renderThread();
    threadScroller.scrollTop += threadScroller.scrollHeight - anchor;
  } catch (err) {
    button.disabled = false;
    notify(err.message);
  }
}
