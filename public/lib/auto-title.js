// A new chat has no title until Hermes names it, after the first reply ends. Until then the first message stands in
// for it (client-side only, never saved), and every title that appears for such a chat is typed out left to right.
import { state } from './state.js';

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const MAX_LEN = 48;

const provisional = new Map(); // sessionId -> text taken from the first message
const typed = new Map(); // sessionId -> the title that is fully on screen
const anim = new Map(); // sessionId -> { text, n, from, down, floor } while a title is being typed (or the old one erased)
let timer = 0;

export function provisionalFrom(text) {
  const line = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split('\n')
    .map((l) => l.replace(/^[\s>#*+-]+|[*_`]/g, '').replace(/\s+/g, ' ').trim())
    .find(Boolean) ?? '';
  if (line.length <= MAX_LEN) return line;
  const cut = line.slice(0, MAX_LEN);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_LEN * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}

export function setProvisional(sessionId, text) {
  if (!sessionId || !text) return;
  provisional.set(sessionId, text);
  typed.set(sessionId, '');
}

export const provisionalTitle = (sessionId) => provisional.get(sessionId) ?? '';

const commonPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

// A title that replaces another is first erased back to what both share, then the new letters are typed.
const shown = (a) => (a.down ? a.from : a.text).slice(0, a.n);

function paint(sessionId) {
  const a = anim.get(sessionId);
  const text = a ? shown(a) : typed.get(sessionId) ?? '';
  const targets = [...document.querySelectorAll('.session-row')].filter((r) => r.dataset.id === sessionId).map((r) => r.querySelector('.session-title'));
  if (state.sessionId === sessionId) targets.push(document.getElementById('chat-title'));
  for (const el of targets) {
    if (!el) continue;
    el.textContent = text;
    el.classList.toggle('is-typing', Boolean(a));
  }
}

function tick() {
  for (const [id, a] of anim) {
    if (a.down) {
      a.n = Math.max(a.floor, a.n - 2);
      if (a.n <= a.floor) a.down = false;
      paint(id);
      continue;
    }
    a.n += 1;
    if (a.n >= a.text.length) {
      typed.set(id, a.text);
      anim.delete(id);
    }
    paint(id);
  }
  if (!anim.size) {
    clearInterval(timer);
    timer = 0;
  }
}

// What a title should show right now: { text, typing }. Chats that never had a stand-in title are shown whole.
export function visibleTitle(session, full) {
  const id = session?.id;
  if (!id || !typed.has(id)) return { text: full, typing: false };
  if (reducedMotion()) {
    typed.set(id, full);
    anim.delete(id);
    return { text: full, typing: false };
  }
  let a = anim.get(id);
  if (!a && typed.get(id) === full) return { text: full, typing: false };
  if (!a) {
    const from = typed.get(id);
    const floor = commonPrefix(from, full);
    a = { text: full, n: from.length, from, down: floor < from.length, floor };
    if (!a.down) a.n = floor;
    anim.set(id, a);
  } else if (a.text !== full) {
    a.floor = Math.min(a.floor, commonPrefix(a.down ? a.from : a.text, full));
    if (!a.down) a.n = Math.min(a.n, commonPrefix(a.text, full));
    a.text = full;
  }
  if (!timer) timer = setInterval(tick, 32);
  return { text: shown(a), typing: true };
}
