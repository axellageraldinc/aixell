import { chatChain } from './llm.js';
import { render } from './prompts.js';

// Word overlap (rank.js) only catches a story told in nearly the same words. The same news from different outlets ("EA is
// shutting down BioWare" / "RIP BioWare: EA has shut down the legendary RPG developer") shares few words, so a small chat model
// reads all recent headlines at once and says which of them are the same event (the free model first, see llm.js chatChain).
const MAX_TITLES = 150;
export const MAX_MERGES_PER_ROUND = 8; // one pass folds a few cards at most; the rest are judged again next round

const SYSTEM = render('dedupe');

export async function findDuplicates(agent, rows) {
  const list = rows.slice(0, MAX_TITLES);
  if (!agent || list.length < 2) return [];
  const groups = await chatChain(agent, { system: SYSTEM, user: JSON.stringify(list.map((r) => ({ id: r.id, t: r.title.slice(0, 140), c: r.cat }))), maxTokens: 3000, timeoutMs: 60_000, temperature: 0 }, (text) => {
    const parsed = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    if (!Array.isArray(parsed)) throw new Error('not a list');
    return parsed;
  });
  const known = new Map(list.map((r) => [r.id, r]));
  const used = new Set();
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    let ids = (Array.isArray(g) ? g : []).map(String).filter((id) => known.has(id) && !used.has(id));
    // One group, one category: the largest category of the group is kept, the rest stay out.
    const cats = ids.map((id) => known.get(id).cat);
    const top = [...cats].sort((a, b) => cats.filter((x) => x === b).length - cats.filter((x) => x === a).length)[0];
    ids = ids.filter((id) => known.get(id).cat === top);
    if (ids.length < 2 || ids.length > 5) continue;
    ids.forEach((id) => used.add(id));
    out.push(ids);
  }
  return out;
}

// Which story of a group stays: one the reader has seen or saved first (nothing seen ever vanishes), then one already on the
// timeline, then the one with a picture and a written summary, then the oldest.
export function pickHost(members) {
  return [...members].sort((a, b) => (b.saved ? 1 : 0) - (a.saved ? 1 : 0) || (b.seen_at ? 1 : 0) - (a.seen_at ? 1 : 0) || (b.status === 'ready') - (a.status === 'ready') || (b.read_at ? 1 : 0) - (a.read_at ? 1 : 0) || b.image - a.image || b.llm - a.llm || (a.ready_at ?? Infinity) - (b.ready_at ?? Infinity))[0];
}
