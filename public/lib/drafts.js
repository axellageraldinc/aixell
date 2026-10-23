// Unsent text and attachments of the composer, remembered per chat (and for the empty "new chat" screen) in this
// browser. Switching chats, leaving the chat for another page and reloading bring the draft back; sending clears it.
import { state, on } from './state.js';

const TEXT_KEY = 'hermes.drafts';
const ATT_KEY = 'hermes.pending';
const MAX_ENTRIES = 60;
const keyOf = () => `${state.agent}:${state.sessionId ?? 'new'}`;

function read(key) {
  try {
    const map = JSON.parse(localStorage.getItem(key) || '{}');
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

function write(key, map) {
  try {
    const keys = Object.keys(map);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete map[old];
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // Storage unavailable: the draft just does not survive a switch.
  }
}

let current = null; // key the composer box belongs to
let bound = null; // { input, after }: set once the composer registers
let atts = null; // { snapshot(), restore(list) } of the attachment tray
let pendingKey = null; // key the tray's items belong to
let lastSig = '';

export function saveDraft(text, key = current ?? keyOf()) {
  const map = read(TEXT_KEY);
  delete map[key]; // re-inserted last, so the newest draft is the last to be trimmed
  if (text.trim() !== '') map[key] = text;
  write(TEXT_KEY, map);
}

export const clearDraft = () => saveDraft('');

// Uploaded files are already on the server, so only their ids, names and kinds are kept; the chips are rebuilt from
// them (an image preview is served back by the upload route).
function savePending(key = pendingKey) {
  if (!atts || !key) return;
  const map = read(ATT_KEY);
  delete map[key];
  const list = atts.snapshot();
  if (list.length) map[key] = list;
  write(ATT_KEY, map);
}

// Called by the composer whenever the tray changes: the signature check keeps this off the typing path.
export function syncPending() {
  if (!atts || !pendingKey || pendingKey !== keyOf()) return;
  const sig = `${pendingKey}|${JSON.stringify(atts.snapshot())}`;
  if (sig === lastSig) return;
  lastSig = sig;
  savePending(pendingKey);
}

export function bindAttachments(api) {
  atts = api;
}

// Puts the draft of the chat that is open back into the box and the tray. force re-applies it even when the chat did
// not change, which repairs a box that something else cleared: reopening the new chat that is already open keeps
// its text instead of throwing it away.
export function restoreDraft({ force = false } = {}) {
  const key = keyOf();
  if (!force && key === current) return;
  // Nothing is written on the way out: every keystroke already saved the box under the key it belonged to, and every
  // tray change saved the files, so swapping to another chat only reads.
  // Typed before the agent was known (the key still says "null"): that text is the newest, it moves to the real key.
  const early = bound && current?.startsWith('null:') && state.agent && bound.input.value.trim() !== '' ? bound.input.value : null;
  if (early !== null) { saveDraft('', current); saveDraft(early, key); }
  current = key;
  lastSig = '';
  if (bound) {
    const text = read(TEXT_KEY)[key] ?? '';
    if (bound.input.value !== text) {
      bound.input.value = text;
      bound.after();
    }
  }
  if (atts) {
    pendingKey = key;
    atts.restore(read(ATT_KEY)[key] ?? []);
  }
  syncPending();
}

// The nameless chat became a real one because its first message was sent: what is in the box belongs to that chat now
// (it was typed after the send), so the draft follows the new key instead of being replaced by the empty one.
export function adoptDraft(from, to) {
  if (current !== from) return;
  current = to;
  if (bound) saveDraft(bound.input.value, to);
  if (atts) {
    pendingKey = to;
    savePending(to);
  }
  syncPending();
}

// input: the composer textarea. after(): called after the text was swapped (resize + button state).
export function initDrafts({ input, after }) {
  bound = { input, after };
  input.addEventListener('input', () => saveDraft(input.value));
  on('session:changed', () => restoreDraft());
  on('session:adopted', ({ from, to } = {}) => adoptDraft(from, to));
  on('agent:select', () => setTimeout(() => restoreDraft(), 0));
  current = null;
  setTimeout(() => restoreDraft(), 0);
}
