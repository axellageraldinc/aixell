import { chatChain } from './llm.js';
import { sharedWords } from './rank.js';
import { render } from './prompts.js';
import * as store from './store.js';

// The same ongoing story told again and again by different articles (a vulnerability, an outage) is not the same EVENT, so dedupe.js
// keeps all of them. A thread is ONE specific event over about three days ("PHP critical RCE"), never a company or a product line.
// The first card stays; a later article stays only when it is a genuinely new development (patch released, exploited in the wild,
// new impact numbers), at most MAX_PER_THREAD cards in all. The rest are folded into the first card as extra outlets, like any other
// duplicate, but only when it is clearly the same event: same category, at least two words in common with the first card, and at most
// MAX_FOLDS_PER_ROUND per pass (a model that is too eager cannot empty the pool). Cards the reader has seen or saved are never folded.
export const MAX_PER_THREAD = 3;
export const MAX_FOLDS_PER_ROUND = 6;
const WINDOW_MS = 3 * 86_400_000;
const BATCH = 30;

const SYSTEM = render('threads');

// -> number of cards folded away. Looks at what has not been looked at yet (new stories and unread ready cards).
export async function groupThreads(agent, { now = Date.now() } = {}) {
  if (!agent) return 0;
  const cands = store.threadCandidates(now - WINDOW_MS, BATCH).filter((c) => {
    const meta = JSON.parse(c.meta ?? '{}');
    if (c.kind === 'steam-sale' || meta.via === 'steam' || meta.release) { store.setThread(c.id, ''); return false; } // Steam cards and releases are never one story
    return true;
  });
  if (!cands.length) return 0;
  const candIds = new Set(cands.map((c) => c.id));
  const known = store.threadKnown(now - WINDOW_MS, 100).filter((k) => !candIds.has(k.id));
  let verdicts;
  try {
    verdicts = await chatChain(agent, { system: SYSTEM, user: JSON.stringify({ known: known.map((k) => ({ id: k.id, t: k.title.slice(0, 120), c: k.cat })), new: cands.map((c) => ({ id: c.id, t: c.title.slice(0, 120), c: c.cat })) }), maxTokens: 2500, timeoutMs: 60_000, temperature: 0 }, (text) => {
      const parsed = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
      if (!Array.isArray(parsed)) throw new Error('not a list');
      return parsed;
    });
  } catch (err) { console.warn(`[fresh] threads failed: ${err.message}`); return 0; }
  const byNew = new Map(verdicts.filter((v) => v && candIds.has(String(v.id))).map((v) => [String(v.id), v]));
  const byId = new Map([...known, ...cands].map((r) => [r.id, r]));
  const tidOf = new Map(); // id -> thread it belongs to, as decided in this pass
  const root = (id) => tidOf.get(id) ?? (byId.get(id)?.thread || id);
  let folded = 0;
  for (const c of cands) {
    const v = byNew.get(c.id);
    const of = v?.of ? String(v.of) : '';
    if (!of || of === c.id || !byId.has(of)) { store.setThread(c.id, ''); continue; }
    const tid = root(of);
    const host = byId.get(tid) ?? store.getItem(tid);
    // One event only: another category, or hardly a word in common with the first card, is not the same event.
    if (!host || host.cat !== c.cat || sharedWords(c.title, host.title) < 2) { store.setThread(c.id, ''); continue; }
    const dev = v.dev === true;
    if (host && !host.thread) store.setThread(tid, tid); // the first card now heads a thread
    if (dev && store.threadSize(tid) < MAX_PER_THREAD) { store.setThread(c.id, tid); tidOf.set(c.id, tid); continue; }
    // A rehash, or the thread already has enough cards: it becomes one more outlet of the first card. Not more than a few per pass:
    // the rest stay unlooked-at and are judged again next round.
    if (folded >= MAX_FOLDS_PER_ROUND) continue;
    tidOf.set(c.id, tid);
    store.setThread(c.id, tid);
    store.markDup(c.id);
    const hostRow = store.getItem(tid);
    if (hostRow) {
      const also = new Set([...(hostRow.also ? JSON.parse(hostRow.also) : [hostRow.source]), c.source]);
      if (also.size > hostRow.outlets) store.corroborate(tid, also.size, [...also]);
    }
    folded += 1;
  }
  return folded;
}
