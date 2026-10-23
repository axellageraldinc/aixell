// The "ingest" connector: a push connector. A Hermes worker posts what it found (anything that
// needs a login or a tool) with the ingest token; this module owns the validation and
// normalisation of those posted items, and the route hands the result to Fresh's store.
//
// The per-connector token is a later change: for now the route keeps the single ingest token file
// and the current path and responses.
import { CATEGORIES, PRIMARY_CAT } from '../fresh/profile.js';

// The batch a posted body carries: anything that is not an array is an empty batch.
export const itemsOf = (body) => (Array.isArray(body?.items) ? body.items : []);

// Validation and normalisation of a posted batch, unchanged from the old freshIngest path:
// at most 60 items, a safe worker source id, a known category, a one-line title, an http(s) url,
// a short snippet and an optional http(s) image.
export function normalizeItems(items) {
  return (Array.isArray(items) ? items : []).slice(0, 60).map((i) => ({
    source: `w-${String(i.source ?? 'worker').replace(/[^\w-]/g, '').slice(0, 24) || 'worker'}`,
    name: String(i.name ?? i.source ?? 'Hermes').slice(0, 60),
    cat: CATEGORIES[i.cat] ? i.cat : PRIMARY_CAT,
    title: String(i.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    url: String(i.url ?? ''),
    snippet: String(i.text ?? i.snippet ?? '').slice(0, 400),
    ts: Number(i.ts) || Date.now(),
    image: /^https?:\/\//.test(i.image ?? '') ? i.image : null,
    meta: { likes: Number(i.likes) || 0 },
  })).filter((i) => /^https?:\/\//.test(i.url) && i.title);
}

export const ingest = {
  type: 'ingest',
  title: 'Ingest (push)',
  push: true,
  configSchema: { type: 'object', properties: {} },
  credentials: [],
  cost: { kind: 'free' },
  itemsOf,
  normalize: normalizeItems,
};

export default ingest;
