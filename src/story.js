import { HttpError } from './http.js';
import { chatChain } from './fresh/llm.js';

// "Share as story": one prompt and its reply have to fit a single 1080x1920 story card. When the text is already short it
// is used as it is; otherwise the writer model shortens both halves (same language, same facts, no new ones). With no
// model, or when the model fails, the text is cut at a sentence or word boundary instead, so sharing never breaks.
export const LIMITS = { prompt: 160, reply: 420 };
const IN_MAX = 12_000; // what is sent to the model per side

const SYSTEM = `You shorten one chat exchange so it fits a single phone story card.
Input: JSON {"prompt": "...", "reply": "..."}. Output: JSON only, {"prompt": "...", "reply": "..."}.
Rules:
- Keep the language of the input. Write plain text: no markdown, no code fences, no bullet symbols, no emoji.
- "prompt" is what the person asked, rewritten as a short first-person line of at most ${LIMITS.prompt} characters.
- "reply" is what the assistant answered: the key answer, with the specific names and numbers that matter, at most ${LIMITS.reply} characters. Short sentences. Connect points with "and" or a full stop instead of lists.
- Never add facts that are not in the input. Never mention that this is a summary.`;

const plain = (text) => String(text ?? '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
  .replace(/[*_`~]+/g, '')
  .replace(/\s+/g, ' ')
  .trim();

// Cuts at the last sentence end that leaves at least half the room, else at a word.
export function clip(text, max) {
  const s = plain(text);
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (stop >= max * 0.5) return cut.slice(0, stop + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut.slice(0, max - 1)).replace(/[\s,.;:!?-]+$/, '')}…`;
}

function parseAnswer(text) {
  const obj = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const prompt = plain(obj?.prompt);
  const reply = plain(obj?.reply);
  if (!prompt || !reply) throw new Error('the model returned an empty side');
  return { prompt: clip(prompt, LIMITS.prompt), reply: clip(reply, LIMITS.reply) };
}

export async function storyText(agent, { prompt, reply } = {}) {
  if (typeof prompt !== 'string' || typeof reply !== 'string' || !prompt.trim() || !reply.trim()) throw new HttpError(400, 'A story needs a prompt and a reply.', 'story_empty');
  const flatPrompt = plain(prompt);
  const flatReply = plain(reply);
  if (flatPrompt.length <= LIMITS.prompt && flatReply.length <= LIMITS.reply) return { prompt: flatPrompt, reply: flatReply, shortened: false };
  try {
    const out = await chatChain(agent, {
      system: SYSTEM,
      user: JSON.stringify({ prompt: flatPrompt.slice(0, IN_MAX), reply: flatReply.slice(0, IN_MAX) }),
      maxTokens: 600, timeoutMs: 40_000,
    }, parseAnswer);
    return { ...out, shortened: true };
  } catch (err) {
    console.warn(`[story] cut without a model: ${err.message}`);
    return { prompt: clip(flatPrompt, LIMITS.prompt), reply: clip(flatReply, LIMITS.reply), shortened: false };
  }
}
