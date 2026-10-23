// What the reader does without saying anything, sent to the server so "For you" learns: which cards were really seen,
// opened, read to the end, lingered on, scrolled past, asked about. Everything here is fire-and-forget: it never blocks the
// screen, swallows every error, and stays under the server's 120-per-minute limit by spacing the calls out.
import { api } from './api.js';

const GAP_MS = 700; // at most ~85 calls a minute, including the seen batches
const QUEUE_MAX = 40;
const SEEN_FLUSH_MS = 4000;
const SEEN_VISIBLE_MS = 1000;
const SKIP_UNDER_MS = 700;

const queue = []; // { id, kind, ms } or { ids }
let timer = 0;
let lastSent = 0;

function pump() {
  if (timer || !queue.length) return;
  const wait = Math.max(0, lastSent + GAP_MS - Date.now());
  timer = setTimeout(() => {
    timer = 0;
    const job = queue.shift();
    lastSent = Date.now();
    if (job) {
      const call = job.ids ? api('/api/fresh/seen', { method: 'POST', body: { ids: job.ids } }) : api(`/api/fresh/${job.id}/signal`, { method: 'POST', body: job.ms ? { kind: job.kind, ms: job.ms } : { kind: job.kind } });
      call.catch(() => {});
    }
    pump();
  }, wait);
}

function enqueue(job, { front = false } = {}) {
  if (queue.length >= QUEUE_MAX) {
    // Quiet signals go first when the line is long; explicit actions (open, ask, save) stay.
    const drop = queue.findIndex((j) => j.kind === 'skip' || j.kind === 'dwell');
    if (drop < 0) return;
    queue.splice(drop, 1);
  }
  if (front) queue.unshift(job); else queue.push(job);
  pump();
}

// kind: open | read | dwell | skip | ask | save | share. ms: for dwell.
export function signal(id, kind, ms) {
  if (!id) return;
  if (queue.some((j) => j.id === id && j.kind === kind)) return;
  enqueue({ id, kind, ms: ms ? Math.round(ms) : 0 });
}

let batch = new Set();
let flushTimer = 0;
export function flushSeen() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  const ids = [...batch];
  batch = new Set();
  for (let i = 0; i < ids.length; i += 100) enqueue({ ids: ids.slice(i, i + 100) });
}
function noteSeen(id) {
  batch.add(id);
  if (batch.size >= 100) flushSeen();
  else if (!flushTimer) flushTimer = setTimeout(flushSeen, SEEN_FLUSH_MS);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSeen(); });

// Watches the cards of one list. A card counts as seen when at least half of it has been on screen for a second; one that
// slid past in under 0.7 s, after the reader has started scrolling, counts as a skip.
export function createSeenTracker({ root, onSeen }) {
  const state = new Map(); // node -> { since, timer }
  const done = new Set(); // ids already reported in this list
  let scrolled = false;
  const forget = (node) => { const s = state.get(node); if (s) { clearTimeout(s.timer); state.delete(node); } };

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const node = entry.target;
      const id = node.dataset.id;
      if (entry.isIntersecting) {
        if (state.has(node) || document.visibilityState !== 'visible') continue;
        const since = performance.now();
        state.set(node, { since, timer: setTimeout(() => {
          const s = state.get(node);
          if (s) s.counted = true;
          if (!done.has(id)) { done.add(id); noteSeen(id); onSeen?.(id); }
        }, SEEN_VISIBLE_MS) });
      } else {
        const s = state.get(node);
        forget(node);
        if (s && !s.counted && scrolled && node.isConnected && performance.now() - s.since < SKIP_UNDER_MS && entry.boundingClientRect.height > 0) signal(id, 'skip');
      }
    }
  }, { root, threshold: [0.5] });

  root.addEventListener('scroll', () => { scrolled = true; }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') for (const node of [...state.keys()]) forget(node); });

  return {
    track(node) { observer.observe(node); },
    // The list is about to be replaced: nothing in it counts as scrolled past.
    reset() { for (const node of [...state.keys()]) forget(node); observer.disconnect(); scrolled = false; },
  };
}
