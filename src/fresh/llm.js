import { CAT_IDS, CATEGORIES, CATEGORY_DEFS, PROFILE, guessCat, hardBan, keywordRelevance, unwanted } from './profile.js';
import { CARD_SCHEMA, categoriesText, content, language, writerLimits } from './content.js';
import { isMeta } from './meta.js';
import { render } from './prompts.js';
import { dayKey } from '../time.js';
import './offline.js';
import * as store from './store.js';
import * as glossary from './glossary.js';
import * as rl from '../providers/ratelimit.js';
import { primaryAgent, providersFor } from '../providers/compat.js';
import { chatOnce, classifyOnce, freeChat, isLimit } from '../providers/chain.js';

// Every model call of Fresh goes through the agent's providers (src/providers/): the `classifier` capability for the typed
// questions (category, taste, deals/spam, writing quality, glossary terms) and the `writer` capability for the cards and the
// small chat jobs (dedupe, threads, term forms). The compat config in src/providers/compat.js reproduces the chains this file
// used to hard-code, so the behaviour is unchanged:
//  - the classifier is free and fast; the router spreads the load over its chain (the model with the most free capacity, jev
//    preferred when idle) and moves on when one errors or times out. Every free model has its own request limit
//    (ratelimit.js, 20 a minute): a call waits for a slot, and a 429 pauses that model.
//  - The writer turns an article into a card in the configured content language. The free chat model goes first, the classifier checks its work, and
//    the paid model (covered by the owner's plan, capped per day) rewrites only what was rejected or failed for real. A busy free
//    model is waited for (up to the writer's waitMs), never a reason to pay.
const S1_CHUNK = 150; // questions per classifier call (100-200 is fine); a provider with a smaller limit cuts it further
const DEFAULT_WAIT_MS = 90_000; // how long the classifier chain is tried before the caller degrades
const DEFAULT_CHAT_WAIT_MS = 30_000; // optional jobs (dedupe, threads) wait less
const DEFAULT_WRITER_WAIT_MS = 90_000; // how long the free writer is waited for before a batch is put off to the next round
const FREE_PER_DAY = 3000;
const PAID_PER_DAY = 200;

// The capability bindings of the agent Fresh runs for. Null capabilities degrade (keyword triage, untranslated cards).
const registryOf = (agent) => providersFor(agent ?? primaryAgent());
const writerConfig = (registry) => registry.config('writer') ?? {};
// A chain is the normal config; a single `model` is the same thing with one entry.
const chainOf = (conf) => (conf?.chain?.length ? conf.chain : conf?.model ? [{ model: conf.model }] : []);
const writerChain = (registry) => chainOf(writerConfig(registry));
const freeEntry = (registry) => writerChain(registry).find((e) => !e.paid) ?? null;
const paidEntry = (registry) => writerChain(registry).find((e) => e.paid) ?? null;
const writerWaitMs = (registry) => writerConfig(registry).waitMs ?? DEFAULT_WRITER_WAIT_MS;
const chatWaitMs = (registry) => writerConfig(registry).chatWaitMs ?? DEFAULT_CHAT_WAIT_MS;
const unmeteredOf = (registry) => Boolean(registry.unmetered?.()); // the offline mock has no limits

// Rate limiting and pausing live in ratelimit.js; these keep the old names.
export const restingModels = () => rl.pausedModels();
export const clearResting = () => rl.reset();

// ---------- usage (per configured-timezone day, kept in the database) ----------
function usage() {
  const u = store.kvGet('llm-usage', null);
  return u?.day === dayKey() ? u : { day: dayKey(), s1: {}, s1Fail: 0, free: 0, paid: 0, rejected: 0, writeErrors: 0, written: 0, paidDueToLimit: 0, paidDueToQuality: 0, paidDueToError: 0, deferredByLimit: 0 };
}
function bump(field, key, n = 1) {
  const u = usage();
  if (key) u[field][key] = (u[field][key] ?? 0) + n; else u[field] = (u[field] ?? 0) + n;
  store.kvSet('llm-usage', u);
}
export const llmUsage = (agent) => {
  // Without an agent the agent Fresh runs for is used, so a status call always shows the chains that are in use.
  const registry = registryOf(agent);
  const free = freeEntry(registry);
  const classifierChain = chainOf(registry.config('classifier'));
  const models = [...classifierChain.map((m) => m.model), ...(free ? [free.model] : [])];
  return { ...usage(), resting: restingModels(), perMinLimit: free ? rl.perMinLimit(free.model) : rl.perMinLimit(''), models: rl.metrics(models) };
};

// ---------- classifier ----------
// The old wire format ({ id: { type, instructions: { item, question }, criteria } }) becomes the provider's typed tasks.
const taskOf = (id, q) => {
  const item = q.instructions?.item ?? '';
  const question = q.instructions?.question ?? '';
  if (q.type === 'choice') return { id, type: 'choice', item, question, options: q.criteria ?? {} };
  if (q.type === 'score') return { id, type: 'score', item, question, scale: q.criteria ?? [] };
  return { id, type: 'bool', item, question, true: q.criteria?.true ?? 'yes', false: q.criteria?.false ?? 'no' };
};
const wireAnswer = (a) => ({ ...(a?.choice !== undefined ? { choice: a.choice } : {}), ...(typeof a?.score === 'number' ? { score: a.score } : {}), ...(typeof a?.p === 'number' ? { noul: a.p } : {}) });

// One classifier call, spread over its chain (see chain.js). Counters: s1 per model, s1Fail per failed attempt.
async function classifyOnceFor(registry, state, questions) {
  const classifier = registry.get('classifier');
  if (!classifier) throw new Error('no classifier provider');
  const conf = registry.config('classifier') ?? {};
  const { answers } = await classifyOnce({
    classify: classifier,
    chain: chainOf(conf),
    state,
    tasks: Object.entries(questions).map(([id, q]) => taskOf(id, q)),
    waitMs: conf.waitMs ?? DEFAULT_WAIT_MS,
    unmetered: unmeteredOf(registry),
    onSuccess: (model) => bump('s1', model),
    onFailure: () => bump('s1Fail'),
  });
  return { answers };
}

// questions: { id: question } -> { id: answer }. Big sets are cut into chunks (one call each, a few at a time).
export async function systemOne(agent, questions, state = PROFILE) {
  const registry = registryOf(agent);
  const classifier = registry.get('classifier');
  if (!classifier) throw new Error('no classifier provider');
  const ids = Object.keys(questions);
  const out = {};
  const size = Math.max(1, Math.min(S1_CHUNK, classifier.maxTasksPerCall ?? S1_CHUNK));
  const chunks = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  for (let i = 0; i < chunks.length; i += 2) {
    await Promise.all(chunks.slice(i, i + 2).map(async (chunk) => {
      const { answers } = await classifyOnceFor(registry, state, Object.fromEntries(chunk.map((id) => [id, questions[id]])));
      for (const [id, a] of Object.entries(answers)) out[id] = wireAnswer(a);
    }));
  }
  return out;
}

const noul = (a) => (typeof a?.noul === 'number' ? a.noul : null);

// ---------- triage: category, taste, ban ----------
// The categories of this deployment, with the meaning that goes into the classifier's choice list.
const CAT_CRITERIA = () => {
  const criteria = Object.fromEntries(CATEGORY_DEFS.map((category) => [category.id, category.label]));
  criteria.none = 'none of these: general news, business, politics, entertainment, or software engineering that fits none of the categories above';
  return criteria;
};
const SCORE_LABELS = ['irrelevant to this reader', 'weakly relevant', 'somewhat relevant', 'relevant', 'a strong match for this reader'];
const itemText = (it) => `${it.title}\n${String(it.snippet ?? '').slice(0, 300)}`;

function triageQuestions(items) {
  const q = {};
  const criteria = CAT_CRITERIA();
  for (const it of items) {
    const item = itemText(it);
    q[`c:${it.id}`] = { type: 'choice', instructions: { item, question: 'Which category fits this story best?' }, criteria };
    q[`r:${it.id}`] = { type: 'score', instructions: { item, question: 'How well does this story match this reader\'s interests and dislikes?' }, criteria: SCORE_LABELS };
    // A post in the content language is not "local news" just for being in that language: only politics and news unrelated to the topics count.
    const where = it.lang ? `politics or general news in ${language()} that is unrelated to the categories above` : `local news in ${language()}`;
    q[`b:${it.id}`] = { type: 'noul', instructions: { item, question: `Is this a shopping deal/discount, a listicle, an ad, a layoff/closure/acquisition story, a sales-figures story, laptop or notebook hardware news, or about Java/Spring, homelab (not self-hosted AI tools), ${where}, or crypto/DeFi/web3/tokens/liquidity pools/NFTs?` }, criteria: { true: 'yes, one of those unwanted kinds', false: 'no, it is a normal story' } };
    q[`i:${it.id}`] = { type: 'noul', instructions: { item, question: 'Does this item carry concrete information (a release, data, a how-to, a benchmark, an announcement), rather than being a meme, a joke, a reaction, a question or a vague discussion?' }, criteria: { true: 'yes, concrete information a reader can use', false: 'no: meme, joke, reaction, opinion without facts, or a post that is only an image' } };
    q[`n:${it.id}`] = { type: 'noul', instructions: { item, question: 'Is this a real news item or useful hands-on content, not spam, clickbait or a bare link?' }, criteria: { true: 'real news or substantive content', false: 'spam, clickbait, empty or purely promotional' } };
  }
  return q;
}

// Words alone, when no model answers: the same shape as a classifier reading.
function heuristic(it) {
  const text = `${it.title} ${it.snippet ?? ''}`;
  const cat = guessCat(text, it.cat);
  return { cat: cat && CATEGORIES[cat] ? cat : null, rel: cat ? keywordRelevance(cat, text) : 0, ban: hardBan(text) || unwanted(text, it.lang) ? 1 : 0, news: 0.7, info: 0.7, by: 'words' };
}

// items: [{ id, title, snippet, cat }] -> Map(id -> { cat|null, rel 0..1, ban 0..1, news 0..1, by })
export async function triage(agent, items) {
  const out = new Map();
  if (!items.length) return out;
  let answers = null;
  try {
    answers = {};
    for (let i = 0; i < items.length; i += 25) Object.assign(answers, await systemOne(agent, triageQuestions(items.slice(i, i + 25))));
  } catch (err) { console.warn(`[fresh] triage fell back to words: ${err.message}`); answers = null; }
  for (const it of items) {
    const a = answers && answers[`c:${it.id}`] ? answers : null;
    if (!a) { out.set(it.id, heuristic(it)); continue; }
    const choice = a[`c:${it.id}`]?.choice;
    const score = a[`r:${it.id}`]?.score;
    out.set(it.id, {
      cat: CAT_IDS.includes(choice) ? choice : null,
      rel: typeof score === 'number' ? Math.max(0, Math.min(1, score / (SCORE_LABELS.length - 1))) : keywordRelevance(choice, itemText(it)),
      ban: noul(a[`b:${it.id}`]) ?? 0, news: noul(a[`n:${it.id}`]) ?? 0.7, info: noul(a[`i:${it.id}`]) ?? 0.7, by: 'model',
    });
  }
  return out;
}

// ---------- chat (free first, paid when the free one fails) ----------
// maxWaitMs: how long to wait for a free slot (the paid model has no limiter); a 429 throws with code 'rate429' after pausing the model.
const paidRoom = (registry) => usage().paid < (paidEntry(registry)?.maxPerDay ?? PAID_PER_DAY);
const freeRoom = (registry) => usage().free < (freeEntry(registry)?.maxPerDay ?? FREE_PER_DAY);

// For jobs where any valid answer will do (dedupe): the free model, and the paid one only if the free one failed or answered
// something `parse` refuses. parse(text) throws on a bad answer.
export async function chatChain(agent, opts, parse) {
  const registry = registryOf(agent);
  const text = registry.get('writer');
  const free = freeEntry(registry);
  const paid = paidEntry(registry);
  if (!text || (!free && !paid)) throw new Error('no writer provider');
  if (free && freeRoom(registry)) {
    try { bump('free'); return parse(await freeChat(text, free, opts, chatWaitMs(registry), { unmetered: unmeteredOf(registry) })); }
    catch (err) {
      if (isLimit(err)) { bump('deferredByLimit'); throw err; } // busy is not a reason to pay: the job waits for the next round
      bump('paidDueToError');
    }
  } else bump('paidDueToLimit');
  if (!paid) throw new Error('no paid writer');
  if (!paidRoom(registry)) throw new Error('paid cap reached');
  bump('paid');
  return parse(await chatOnce(text, paid, opts, { unmetered: unmeteredOf(registry) }));
}

// ---------- writer ----------
// The prompt is a template (src/fresh/prompts/writer.md) so the content language, the reader and the
// limits are configuration, not code. The JSON keys are the same in every language.
const writerPrompt = () => render('writer', {
  language: language(),
  profile: PROFILE,
  categories: categoriesText(),
  schema: CARD_SCHEMA,
  ...writerLimits(),
});

// Words that make a card read like an advertisement. Hype is language-specific, so it is checked
// only against the shipped English list; a deployment in another language can add its own list
// in data/filters/hype.<code>.json later without touching this file.
const HYPE = /\b(revolutionary|game[- ]?changer|game-changing|breathtaking|mind-blowing|insane|you won't believe|must[- ]see|must[- ]have)\b/i;

// Cheap checks before a model is asked: shape, length, hype, sentences about the text itself.
function parseCards(text, ids) {
  const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  const list = JSON.parse(json);
  const out = new Map();
  for (const r of Array.isArray(list) ? list : []) {
    const title = r?.title;
    const summary = r?.summary;
    if (!r?.id || !ids.has(String(r.id)) || typeof title !== 'string' || typeof summary !== 'string') continue;
    const substance = r.substance;
    const topics = r.topics;
    out.set(String(r.id), {
      title_local: title.trim().slice(0, 140), summary: summary.trim().slice(0, 600), why: String(r.why ?? '').trim().slice(0, 200),
      substance: substance !== false,
      topics: (Array.isArray(topics) ? topics : []).map((t) => String(t).toLowerCase().trim()).filter((t) => t && t.length < 32).slice(0, 4),
    });
  }
  return out;
}
const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`);
function plainProblem(card) {
  const limits = writerLimits();
  if (!card.title_local || card.title_local.length > limits.titleMax + 5) return 'title length';
  if (card.summary.length < 30) return 'summary short';
  const all = `${card.title_local} ${card.summary} ${card.why}`;
  if (HYPE.test(all)) return 'hype';
  if (isMeta(all, content().languageCode)) return 'meta';
  return '';
}

async function qualityCheck(agent, batch, cards) {
  const q = {};
  for (const b of batch) {
    const c = cards.get(b.id);
    if (!c) continue;
    q[`ok:${b.id}`] = {
      type: 'noul',
      instructions: { item: `SOURCE (${b.sourceName}): ${b.title}\n${(b.text || b.description || b.snippet || '').slice(0, 1800)}\n\nCARD:\nTitle: ${c.title_local}\nSummary: ${c.summary}\nWhy: ${c.why}`, question: 'Is the card well written?' },
      criteria: { true: `acceptable: readable ${language()}, technical terms left in English where natural, the facts come from the source, neutral tone`, false: `clearly bad: stiff or machine-translated ${language()}, absurdly translated technical terms, facts that contradict or are missing from the source, hype or clickbait wording, or sentences about the text itself` },
    };
  }
  const answers = await systemOne(agent, q, render('quality', { language: language(), profile: PROFILE }));
  return new Map(Object.keys(answers).map((k) => [k.slice(3), noul(answers[k]) ?? 0.5]));
}

// 8 cards a call: about 300 tokens of output each (title + summary + why + topics), so max_tokens 400 * 8 + 200 = 3400 is ample.
export const WRITE_BATCH = 8;
const askWriter = (registry, entry, batch, rules = new Map()) => {
  const text = registry.get('writer');
  if (!text || !entry) throw new Error('no writer provider');
  const opts = {
    system: writerPrompt(), user: JSON.stringify(batch.map((b) => ({ id: b.id, title: b.title, source: b.sourceName, text: (b.text || b.description || b.snippet || '').slice(0, 1800), ...(rules.get(b.id)?.text ? { terms: rules.get(b.id).text } : {}) }))),
    maxTokens: 400 * batch.length + 200, timeoutMs: 40_000 + 6_000 * batch.length,
  };
  return entry.paid ? chatOnce(text, entry, opts, { unmetered: unmeteredOf(registry) }) : freeChat(text, entry, opts, writerWaitMs(registry), { unmetered: unmeteredOf(registry) });
};

// ---------- glossary: which terms of a source stay English (decided once, cached; see glossary.js) ----------
const GLOSS_ASK_MAX = 20;
const TRANSLATE_AT = 0.6; // the classifier's yes-score above which a term is translated (measured: privacy 0.72, vulnerability 0.44, agent 0.21)
const sourceText = (b) => `${b.title}\n${b.text || b.description || b.snippet || ''}`.slice(0, 2400);

// The free writer gives a {{language}} rendering for terms the classifier wants translated and the fixed map does not cover.
async function askForms(agent, terms) {
  try {
    const registry = registryOf(agent);
    const text = registry.get('writer');
    const free = freeEntry(registry);
    if (!text || !free) return {};
    bump('free');
    const out = await freeChat(text, free, {
      system: render('terms', { language: language() }),
      user: JSON.stringify(terms), maxTokens: 40 * terms.length + 100, timeoutMs: 30_000,
    }, chatWaitMs(registry), { unmetered: unmeteredOf(registry) });
    const obj = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
    return Object.fromEntries(terms.map((t) => [t, String(obj?.[t] ?? '').toLowerCase().trim()]).filter(([t, f]) => /^[\p{L}0-9][\p{L}0-9 -]{1,38}$/u.test(f) && f !== t));
  } catch { return {}; }
}

// terms: [{ term, ctx }] -> decides each with the classifier and caches it. A failed call caches nothing (asked again next time).
export async function decideTerms(agent, terms) {
  const list = terms.slice(0, GLOSS_ASK_MAX);
  if (!list.length) return new Map();
  const q = {};
  for (const { term, ctx } of list) {
    // A yes/no score separates terms better than a keep-or-translate choice (the router always picked "keep" for the choice form).
    q[`g:${term}`] = {
      type: 'noul', instructions: { item: `Term: "${term}"\nIn context: ${ctx || term}`, question: `Do ${language()} tech writers normally use a ${language()} word instead of the English word "${term}"?` },
      criteria: { true: `yes: a ${language()} word is the normal choice and the English word is the less common one`, false: 'no: the English word is what developers and gamers write' },
    };
  }
  const answers = await systemOne(agent, q, `You decide how ${language()} developers and gamers write English technology terms in casual articles. Prefer keeping the English term unless a ${language()} word is clearly the usual one.`);
  const out = new Map();
  const wantForm = [];
  for (const { term } of list) {
    const score = noul(answers[`g:${term}`]);
    if (score === null) continue;
    if (score >= TRANSLATE_AT) {
      if (glossary.knownForm(term)) out.set(term, `${content().languageCode}:${glossary.knownForm(term)}`); else wantForm.push(term);
    } else out.set(term, 'keep');
  }
  if (wantForm.length) {
    const forms = await askForms(agent, wantForm);
    for (const t of wantForm) out.set(t, forms[t] ? `${content().languageCode}:${forms[t]}` : 'keep');
  }
  for (const [term, decision] of out) glossary.cacheDecision(term, decision);
  return out;
}

// batch -> Map(id -> { text, used, names }): the glossary rules of every source in the batch. Never throws (no rules is fine).
export async function glossaryRules(agent, batch) {
  const out = new Map();
  try {
    let ex = new Map(batch.map((b) => [b.id, glossary.extract(sourceText(b))]));
    const ask = new Map();
    for (const b of batch) for (const t of ex.get(b.id).unknown) if (!ask.has(t)) ask.set(t, glossary.contextOf(t, sourceText(b)));
    if (ask.size) {
      try { await decideTerms(agent, [...ask].map(([term, ctx]) => ({ term, ctx }))); } catch (err) { console.warn(`[fresh] glossary decisions unavailable: ${err.message}`); }
      const all = glossary.entries();
      ex = new Map(batch.map((b) => [b.id, glossary.extract(sourceText(b), all)]));
    }
    const hit = new Set();
    for (const b of batch) {
      const { entries, names } = ex.get(b.id);
      entries.forEach((e) => hit.add(e.term));
      out.set(b.id, { text: glossary.rulesText(entries, names), used: entries, names });
    }
    if (hit.size) store.glossaryHit([...hit]);
  } catch (err) { console.warn(`[fresh] glossary rules failed: ${err.message}`); }
  return out;
}

// batch: [{ id, title, sourceName, text, description, snippet }] -> Map(id -> { title_local, summary, why, topics, path: 'free'|'paid' }).
// `rules`: the glossary rules of the whole round when the caller already asked for them (one classifier call for all batches).
// The returned map also has `.deferred`: ids put off because the free model stayed busy (they are not paid for and not counted as a failed try).
// With no writer provider the map is empty and the caller keeps the source's own words (untranslated cards).
export async function writeCards(agent, batch, { rules: given = null } = {}) {
  const ids = new Set(batch.map((b) => b.id));
  const done = new Map();
  done.deferred = new Set();
  const registry = registryOf(agent);
  const free = freeEntry(registry);
  const paid = paidEntry(registry);
  if (!registry.get('writer') || (!free && !paid)) return done;
  const why = new Map(); // id -> why it needs the paid writer: 'quality' | 'error' | 'limit'
  let todo = batch;
  const rules = given ?? await glossaryRules(agent, batch);
  // Forbidden renderings of kept terms are swapped for the English term; a card that still has one (inside a derived word) is not accepted.
  const polish = (cards) => {
    const unsafe = new Set();
    for (const [id, card] of cards) {
      const r = glossary.fixCard(card, rules.get(id)?.used ?? []);
      if (r.fixes.length) bump('termFixed');
      cards.set(id, r.card);
      if (r.unsafe) unsafe.add(id);
    }
    return unsafe;
  };
  if (free && freeRoom(registry)) {
    try {
      bump('free');
      const cards = parseCards(await askWriter(registry, free, batch, rules), ids);
      const unsafe = polish(cards);
      const plain = batch.filter((b) => cards.has(b.id) && !unsafe.has(b.id) && !plainProblem(cards.get(b.id)));
      let checks = new Map();
      try { checks = await qualityCheck(agent, plain, cards); } catch (err) { console.warn(`[fresh] quality check unavailable: ${err.message}`); checks = new Map(plain.map((b) => [b.id, 0.6])); }
      for (const b of batch) {
        const ok = plain.includes(b) && (checks.get(b.id) ?? 0) >= 0.5;
        if (ok) done.set(b.id, { ...cards.get(b.id), path: 'free' });
        else if (cards.has(b.id)) { bump('rejected'); why.set(b.id, 'quality'); } else why.set(b.id, 'error'); // missing from the answer
      }
      todo = batch.filter((b) => !done.has(b.id));
    } catch (err) {
      if (isLimit(err)) {
        // The free model stayed busy for the whole wait: put the batch off. Paying would only hide a limit that passes.
        bump('deferredByLimit', null, batch.length);
        batch.forEach((b) => done.deferred.add(b.id));
        todo = [];
        console.warn(`[fresh] free writer busy, ${batch.length} stories wait for the next round: ${err.message}`);
      } else {
        bump('writeErrors'); console.warn(`[fresh] free writer failed: ${err.message}`);
        batch.forEach((b) => why.set(b.id, 'error'));
      }
    }
  } else batch.forEach((b) => why.set(b.id, 'limit')); // the free daily allowance is used up (or there is no free model)
  if (todo.length && paid && paidRoom(registry)) {
    try {
      bump('paid');
      const cards = parseCards(await askWriter(registry, paid, todo, rules), new Set(todo.map((b) => b.id)));
      polish(cards);
      for (const b of todo) {
        if (!cards.has(b.id)) continue;
        done.set(b.id, { ...cards.get(b.id), title_local: clip(cards.get(b.id).title_local, writerLimits().titleMax), path: 'paid' });
        bump({ quality: 'paidDueToQuality', error: 'paidDueToError', limit: 'paidDueToLimit' }[why.get(b.id) ?? 'error']);
      }
    } catch (err) { bump('writeErrors'); console.warn(`[fresh] paid writer failed: ${err.message}`); }
  }
  const u = usage();
  u.written += done.size;
  store.kvSet('llm-usage', u);
  return done;
}

// A yes/no about one text (the "keep this term in English?" style decisions and similar small questions).
export async function askYesNo(agent, item, question, yes, no) {
  const a = await systemOne(agent, { q: { type: 'noul', instructions: { item, question }, criteria: { true: yes, false: no } } });
  return noul(a.q);
}
