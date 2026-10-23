import { ProviderError } from './errors.js';

// A classifier built from any chat model: N typed tasks are packed into one JSON-mode prompt and the answers are parsed back.
// Used when a provider has no classifier of its own. Scores are positions in the task's label list (0..n-1) and bool answers
// are probabilities (0..1), the same shapes a native classifier returns.
export const MAX_TASKS_PER_CALL = 20;

export const SYSTEM_PROMPT = [
  'You are a careful classifier. Reply with ONLY one JSON object that maps every task id to its answer, no commentary.',
  'Task types:',
  '- "choice": the answer is the KEY of the option that fits best (one of the keys in "options").',
  '- "score": the answer is an integer, the 0-based position of the label in "scale" that fits best.',
  '- "bool": the answer is a number from 0 to 1, the probability that the answer is yes ("true" describes yes, "false" describes no).',
].join('\n');

export function buildPrompt(state, tasks) {
  const list = tasks.map((t) => {
    const base = { id: t.id, type: t.type, item: t.item, question: t.question };
    if (t.type === 'choice') return { ...base, options: t.options };
    if (t.type === 'score') return { ...base, scale: t.scale };
    return { ...base, true: t.true, false: t.false };
  });
  return {
    system: `${SYSTEM_PROMPT}${state ? `\nContext: ${state}` : ''}`,
    user: JSON.stringify(list),
  };
}

export function parseAnswers(text, tasks) {
  const start = String(text).indexOf('{'), end = String(text).lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('classifier answered without JSON');
  const raw = JSON.parse(String(text).slice(start, end + 1));
  const out = {};
  for (const t of tasks) {
    let a = raw?.[t.id];
    if (a && typeof a === 'object') a = a.answer ?? a.choice ?? a.score ?? a.p;
    if (a === undefined || a === null) continue;
    if (t.type === 'choice') {
      const key = String(a);
      if (key in t.options) out[t.id] = { choice: key };
    } else if (t.type === 'score') {
      const n = Math.round(Number(a));
      if (Number.isFinite(n)) out[t.id] = { score: Math.max(0, Math.min(t.scale.length - 1, n)) };
    } else {
      const p = Number(typeof a === 'boolean' ? (a ? 1 : 0) : a);
      if (Number.isFinite(p)) out[t.id] = { p: Math.max(0, Math.min(1, p)) };
    }
  }
  return out;
}

// text: a TextProvider; model: the default chat model used when a call names none.
export function llmClassifier(text, { model } = {}) {
  return {
    maxTasksPerCall: MAX_TASKS_PER_CALL,
    async classify({ state = '', tasks, model: asked, timeoutMs = 60_000 }) {
      const { system, user } = buildPrompt(state, tasks);
      const { text: reply } = await text.chat({
        model: asked ?? model, temperature: 0, maxTokens: 40 * tasks.length + 200, timeoutMs, reasoningEffort: 'none',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      const answers = parseAnswers(reply, tasks);
      if (!Object.keys(answers).length) throw new ProviderError(`${asked ?? model} no answers`, { kind: 'empty' });
      return answers;
    },
  };
}
