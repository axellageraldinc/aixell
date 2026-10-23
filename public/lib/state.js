// Shared app state and a tiny event bus. UI modules notify each other through emit/on.
import { navigate } from './back-nav.js';

export const state = {
  me: null,
  agents: [],
  agent: null,
  source: 'web',
  sessions: [],
  sessionsHasMore: false,
  sessionId: null,
  session: null,
  models: null,
  agentOffline: false,
  // Per-session chat settings (model, effort, tier). Key: "agent:sessionId" or "agent:new".
  settings: new Map(),
  // Prompt size of the latest call per session: { tokens, approx } (drives the context meter).
  lastPromptTokens: new Map(),
  // Replies in flight, keyed by sessionKey(agent, sessionId): a run keeps streaming while another chat is
  // open, so several talks can be working at the same time. Values are the run contexts built in chat.js.
  runs: new Map(),
};

// Start-up: the account (CSRF token) and the agent list arrive after the screen is already usable. Sending waits on
// boot.ready; boot.pending tells the composer to show a pending state instead of "no agent".
export const boot = { pending: true, done: () => {}, ready: null };
boot.ready = new Promise((resolve) => { boot.done = () => { boot.pending = false; resolve(); emit('boot:ready'); }; });

const bus = new EventTarget();

export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

// Returns an unsubscribe function.
export function on(type, handler) {
  const listener = (event) => handler(event.detail);
  bus.addEventListener(type, listener);
  return () => bus.removeEventListener(type, listener);
}

export const sessionKey = (agent, sessionId) => `${agent}:${sessionId ?? 'new'}`;

// The run context of one chat, or null when it has no reply in flight.
export const liveRun = (agent, sessionId) => state.runs.get(sessionKey(agent, sessionId)) ?? null;

// Session ids of one agent that have a reply in flight (drives the sidebar marks).
export const runningSessionIds = (agent) =>
  new Set([...state.runs.values()].filter((ctx) => ctx.agent === agent && ctx.run.sessionId).map((ctx) => ctx.run.sessionId));

const LAST_AGENT_KEY = 'hermes.lastAgent';

// localStorage holds a UI preference only; failures are ignored.
export function readLastAgent() {
  try {
    return localStorage.getItem(LAST_AGENT_KEY);
  } catch {
    return null;
  }
}

export function saveLastAgent(name) {
  try {
    localStorage.setItem(LAST_AGENT_KEY, name);
  } catch {
    // Storage unavailable: ignore.
  }
}

// The agent start-up ended on (chosen by the user or the default one): the next start assumes it while the list loads.
export function readBootAgent() {
  try {
    return localStorage.getItem('hermes.bootAgent');
  } catch {
    return null;
  }
}

export function saveBootAgent(name) {
  try {
    if (name) localStorage.setItem('hermes.bootAgent', name);
  } catch {
    // Storage unavailable: the next start just waits for the list.
  }
}

const lastSessionKey = (agent) => `hermes.lastSession.${agent}`;

// The chat that was open in this browser, so a reload comes back to it.
export function readLastSession(agent) {
  try {
    return localStorage.getItem(lastSessionKey(agent));
  } catch {
    return null;
  }
}

export function saveLastSession(agent, sessionId) {
  try {
    if (sessionId) localStorage.setItem(lastSessionKey(agent), sessionId);
    else localStorage.removeItem(lastSessionKey(agent));
  } catch {
    // Storage unavailable: ignore.
  }
}

// Deep link to one chat: #/<agent>/<chat id>.
export function readRoute() {
  const match = location.hash.match(/^#\/([\w-]+)\/([\w.-]+)$/);
  return match ? { agent: match[1], id: match[2] } : null;
}

export function writeRoute(agent, sessionId) {
  navigate(sessionId ? `#/${agent}/${sessionId}` : location.pathname + location.search);
}
