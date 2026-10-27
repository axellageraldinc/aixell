// Model catalogue for the current agent, per-session chat settings and context-window maths.
import { api, agentPath } from './api.js';
import { state, emit, sessionKey } from './state.js';

let status = 'loading'; // 'loading' | 'ready' | 'error'
let errorMessage = '';

export const modelsStatus = () => ({ status, errorMessage });
export const findModel = (id) => state.models?.models.find((m) => m.id === id) ?? null;
export const currentSettings = () => state.settings.get(sessionKey(state.agent, state.sessionId)) ?? {};
export const effectiveModelId = () => currentSettings().model ?? state.models?.current?.model ?? null;

// silent: refresh in place (the list stays on screen) - used when the picker opens, so models switched off in the
// provider console disappear without a page reload.
export async function loadModels({ silent = false } = {}) {
  const agent = state.agent;
  if (!agent) return;
  if (!silent) {
    state.models = null;
    status = 'loading';
    emit('models:changed');
  }
  try {
    const data = await api(`${agentPath(agent)}/models`);
    if (agent !== state.agent) return;
    state.models = data;
    status = 'ready';
    // A routed gateway knows the real model of the open chat; ask once the catalogue says it is routed.
    if (data.routed === true) loadServedModel();
  } catch (err) {
    if (agent !== state.agent || (silent && state.models)) return;
    status = 'error';
    errorMessage = err.message;
  }
  emit('models:changed');
}

// Whether an effort may be sent for this model.
//
// A plain catalogue knows which of its models can think, so an effort is only offered for those. A routed
// gateway (xellter) resolves the real model per request and its catalogue entry carries no such flag, so the
// flag would silently drop the effort the owner picked. The gateway decides what to do with it.
const effortAllowed = (model) => state.models?.routed === true || findModel(model)?.reasoning === true;

// Options sent with every chat request: only what the user picked plus the model the UI shows.
export function chatOptions() {
  const current = state.models?.current ?? {};
  const s = currentSettings();
  const model = s.model ?? current.model;
  const provider = s.provider ?? current.provider;
  const options = {};
  if (model) options.model = model;
  if (provider) options.provider = provider;
  const effort = s.reasoningEffort ?? state.models?.defaultEffort;
  if (effort && effortAllowed(model)) options.reasoningEffort = effort;
  if (s.serviceTier) options.serviceTier = s.serviceTier;
  // Visualize is off unless this chat turned it on; the server only adds the grammar prompt when it is true.
  if (s.visualize === true) options.visualize = true;
  return options;
}

export function updateSettings(patch) {
  const key = sessionKey(state.agent, state.sessionId);
  const next = { ...(state.settings.get(key) ?? {}), ...patch };
  for (const field of Object.keys(next)) if (next[field] === undefined) delete next[field];
  state.settings.set(key, next);
  emit('settings:changed');
}

export function resetSettings() {
  state.settings.delete(sessionKey(state.agent, state.sessionId));
  emit('settings:changed');
}

// The per-chat Visualize switch. Default off, including for a chat that never touched it.
export const visualizeOn = () => currentSettings().visualize === true;

export function setVisualize(on) {
  updateSettings({ visualize: on === true ? true : undefined });
}

// A chat that gets its first message turns from "new" into a real session: carry the settings over.
export function adoptNewSessionSettings(agent, sessionId) {
  const from = sessionKey(agent, null);
  if (!state.settings.has(from)) return;
  state.settings.set(sessionKey(agent, sessionId), state.settings.get(from));
  state.settings.delete(from);
}

// A new chat starts from the agent's defaults: nothing is carried over from the chat that was open.
export function resetNewChatSettings() {
  state.settings.delete(sessionKey(state.agent, null));
  emit('settings:changed');
}

// Prompt size of the last call against the model's context window. Unknown parts stay null.
export function contextInfo() {
  const known = state.lastPromptTokens.get(sessionKey(state.agent, state.sessionId)) ?? null;
  const used = known?.tokens ?? null;
  const approx = Boolean(known?.approx);
  const windowSize = findModel(effectiveModelId())?.contextWindow ?? null;
  const ratio = used != null && windowSize ? used / windowSize : null;
  const level = ratio == null ? 'ok' : ratio > 0.9 ? 'danger' : ratio > 0.7 ? 'warn' : 'ok';
  return { used, approx, windowSize, ratio, level };
}

// Reopening a chat: the model / effort / speed last used there (kept by the server) become the selection again.
export function seedSettings(agent, session) {
  const key = sessionKey(agent, session.id);
  if (state.settings.has(key)) return;
  const saved = session.web_settings ?? (session.model ? { model: session.model } : null);
  if (!saved) return;
  state.settings.set(key, { ...saved });
  emit('settings:changed');
}

// Hermes stores a run's exact prompt size slightly after the run ends. Until it shows up, the server still reports the
// previous run's value; that old number must not replace the fresher figure taken from the run itself.
const staleContext = new Map(); // key -> { tokens: the pre-run exact value, until: ms }
const STALE_FOR_MS = 60_000;
export function markContextStale(key, tokens) {
  if (Number.isFinite(tokens)) staleContext.set(key, { tokens, until: Date.now() + STALE_FOR_MS });
}

// While a run is in progress the exact figure is polled from the server (it moves with every model call). Once one has
// been seen, the end-of-run average (a rougher number) must not replace it.
const liveSeeded = new Set();
export const noteLiveSeed = (key) => liveSeeded.add(key);
export const hadLiveSeed = (key) => liveSeeded.has(key);
export const clearLiveSeed = (key) => liveSeeded.delete(key);

// The real model behind a routed gateway, per chat: the gateway pins one model per conversation, so the composer can
// name it beside the route ("xellter - agnes-3-0-flash:free"). Only a routed catalogue has one; otherwise null.
const served = new Map(); // key -> model id (string) | null
const servedAt = new Map(); // key -> ms of the last read attempt (throttle)
const servedToken = new Map(); // key -> newest read, so an older answer cannot overwrite it
const SERVED_MIN_GAP_MS = 4_000;

export const servedModelId = () => (state.models?.routed === true ? served.get(sessionKey(state.agent, state.sessionId)) ?? null : null);

// Best effort: a gateway that cannot say (no traffic yet, no such endpoint) leaves the plain route name. `sessionId`
// is explicit because a run reports it for the chat it belongs to, which need not be the chat on screen.
export async function loadServedModel(sessionId = state.sessionId) {
  const agent = state.agent;
  if (!agent || !sessionId || state.models?.routed !== true) return;
  const key = sessionKey(agent, sessionId);
  const now = Date.now();
  if (now - (servedAt.get(key) ?? 0) < SERVED_MIN_GAP_MS) return;
  servedAt.set(key, now);
  const token = (servedToken.get(key) ?? 0) + 1;
  servedToken.set(key, token);
  try {
    const data = await api(`${agentPath(agent)}/models/served?session=${encodeURIComponent(sessionId)}`);
    if (servedToken.get(key) !== token) return; // a newer read already answered
    const model = typeof data?.model === 'string' && data.model ? data.model : null;
    if (served.has(key) && served.get(key) === model) return; // nothing changed on screen
    served.set(key, model);
    emit('models:served');
  } catch { /* keep the route name; the next turn asks again */ }
}

// Prompt size of the chat's latest call, kept by the server so it survives a reload. Never overrides a fresher value.
export function seedContext(agent, session) {
  const key = sessionKey(agent, session.id);
  const server = session.web_context;
  if (!server) return;
  const stale = staleContext.get(key);
  if (stale) {
    if (Date.now() > stale.until || server.tokens !== stale.tokens) staleContext.delete(key);
    else if (!server.approx) return; // still the previous run's number
  }
  // The server value is exact when it comes from Hermes' own anchor; an estimate never replaces a value we hold.
  if (!server.approx || !state.lastPromptTokens.has(key)) state.lastPromptTokens.set(key, server);
}
