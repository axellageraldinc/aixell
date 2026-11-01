import { providersFor } from '../providers/compat.js';
import * as store from './store.js';

// Search by meaning. Every ready story gets one embedding (the `embeddings` capability: an OpenAI style /embeddings endpoint);
// the vectors are stored unit-length in fresh.db, so cosine similarity is a dot product. The pool is a few thousand stories at
// most (stories are kept 14 days), so a plain scan is fast enough and needs no index.
const BATCH = 16;
// bge-m3 scores: unrelated texts sit near 0.35, related ones from 0.5, the same topic from about 0.6.
export const SAME_TOPIC = 0.6;
const MAX_TEXT = 1200;

const unit = (values) => {
  const v = Float32Array.from(values);
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i += 1) v[i] /= n;
  return v;
};
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]; return s; };

// The text that stands for a story: both titles (the original and the card's own language), the card summary and the topics.
export function textOf(row) {
  let topics = '';
  try { topics = JSON.parse(row.topics ?? '[]').join(', '); } catch { topics = String(row.topics ?? ''); }
  const parts = [row.title, row.title_local && row.title_local !== row.title ? row.title_local : '', row.summary, topics];
  return parts.filter(Boolean).join('\n').slice(0, MAX_TEXT);
}

// -> { embed, model } or null when no embedding provider is configured.
export function embedder(agent) {
  const registry = providersFor(agent);
  const impl = registry.get('embeddings');
  const model = registry.config('embeddings')?.model;
  return impl && model ? { embed: impl.embed, model } : null;
}

// Embeds up to `limit` ready stories that have no vector yet. Returns how many were stored; a failing server stops the run quietly.
export async function embedPending(agent, limit = 64) {
  const e = embedder(agent);
  if (!e) return 0;
  let done = 0;
  const rows = store.needVectors(e.model, limit);
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    try {
      const vectors = await e.embed({ input: batch.map(textOf), model: e.model, timeoutMs: 60_000 });
      batch.forEach((row, k) => store.vectorPut(row.id, e.model, unit(vectors[k])));
      done += batch.length;
    } catch (err) {
      console.warn(`[fresh] embedding failed: ${err.message}`);
      break;
    }
  }
  return done;
}

function rank(pool, query, limit, minScore, skip = null) {
  const hits = [];
  for (const item of pool) {
    if (item.id === skip || item.vec.length !== query.length) continue;
    const score = dot(item.vec, query);
    if (score >= minScore) hits.push({ id: item.id, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// -> [{ id, score }] best first, or null when search by meaning is not available (no provider, or the server is down).
export async function search(agent, text, { cat = '', saved = false, limit = 20, minScore = 0.5 } = {}) {
  const e = embedder(agent);
  const q = String(text ?? '').trim().slice(0, 300);
  if (!e || !q) return null;
  let query;
  try { query = unit((await e.embed({ input: [q], model: e.model, timeoutMs: 8000 }))[0]); } catch (err) { console.warn(`[fresh] search embedding failed: ${err.message}`); return null; }
  return rank(store.vectorPool(e.model, { cat, saved }), query, limit, minScore);
}

// Stories closest in meaning to a given story (itself excluded); null when it has no vector.
export function similar(agent, id, { limit = 10, minScore = 0.5 } = {}) {
  const e = embedder(agent);
  const own = e ? store.vectorGet(id, e.model) : null;
  return own ? rank(store.vectorPool(e.model), own, limit, minScore, id) : null;
}

// id -> unit vector for the given stories (those without one are missing from the map).
export function vectorsFor(agent, ids) {
  const e = embedder(agent);
  const map = new Map();
  if (e) for (const id of ids) { const v = store.vectorGet(id, e.model); if (v) map.set(id, v); }
  return map;
}

export const coverage = (agent) => { const e = embedder(agent); return e ? { model: e.model, ...store.vectorStats(e.model) } : null; };
