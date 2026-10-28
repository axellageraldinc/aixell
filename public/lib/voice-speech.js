// Pure helpers for the voice chat (no DOM): cutting a streamed reply into chunks that can be spoken, turning
// markdown into the plain words that are read out, and timing the words of a chunk against its audio so they can be
// highlighted like karaoke lyrics.

// The speech server leaves this long a silence after every sentence inside one request (seconds).
export const SENTENCE_GAP = 0.35;
// Silence the model leaves at the end of a clip (seconds): not spent on words.
const TAIL = 0.15;

const SENTENCE_END = /[.!?…]["')\]]*$/;

// Markdown to what a person would read aloud. Code blocks, links' addresses, images and emoji are dropped; list
// items and paragraphs become sentences so they are spoken with a pause.
export function plainText(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|\s)[*_]+(?=\S)/g, '$1')
    .replace(/([^\s*_])[*_]+(?=\s|$|[.,;:!?])/g, '$1')
    .replace(/[\u{1F000}-\u{1FFFF}☀-➿️‍]/gu, ' ')
    .replace(/\|/g, ' ')
    .replace(/([^.!?…:\s])[ \t]*\n+[ \t]*/g, '$1. ')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Where the first speakable chunk of `buf` ends (an index into it), or 0 when it should wait for more text.
// A chunk ends at a sentence end (a '.', '!', '?' or '…' followed by white space, or a line break) and holds at least
// `minLen` characters, so a short sentence is joined with the next one. A buffer that grows past `max` without a
// sentence end is cut at the last comma or space.
function boundary(buf, minLen, max) {
  const re = /[.!?…]+["')\]]*(?=\s)|\n/g;
  let m;
  while ((m = re.exec(buf))) {
    const end = m.index + m[0].length;
    if (end >= minLen) return end;
  }
  if (buf.length <= max) return 0;
  const comma = buf.lastIndexOf(', ', max);
  const space = buf.lastIndexOf(' ', max);
  return (comma > max / 2 ? comma + 1 : space > 0 ? space : max);
}

// A reply arrives in small deltas. push() returns the chunks that are complete so far; end() returns the rest.
// The first chunk is short so the voice starts early; later ones are a few sentences, because each one costs a
// round trip to the speech server.
export function createChunker({ firstMin = 18, min = 70, max = 260 } = {}) {
  let buf = '';
  let first = true;
  const cut = () => {
    const out = [];
    for (;;) {
      const at = boundary(buf, first ? firstMin : min, max);
      if (at <= 0) return out;
      const chunk = plainText(buf.slice(0, at));
      buf = buf.slice(at);
      if (chunk) { out.push(chunk); first = false; }
    }
  };
  return {
    push(delta) { buf += delta; return cut(); },
    end() {
      const out = cut();
      const rest = plainText(buf);
      buf = '';
      if (rest) out.push(rest);
      return out;
    },
  };
}

// How long a word takes to say, relative to the others: its letters, a number's digits count more (it is spoken as
// several words), and a comma adds a breath.
function weight(word) {
  const digits = (word.match(/\d/g) ?? []).length;
  const letters = (word.match(/\p{L}/gu) ?? []).length;
  return Math.max(1, letters + digits * 2.5) + (/[,;:]["')\]]*$/.test(word) ? 2 : 0);
}

// The words of a chunk with the time (seconds from the start of its audio) each one starts and ends, given how long
// the audio is. Words are spread over the duration by weight; the silences the speech server puts between the
// sentences of one chunk are taken out first.
export function wordTimings(text, duration) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const gapAfter = words.map((word, i) => i < words.length - 1 && SENTENCE_END.test(word));
  const gaps = gapAfter.filter(Boolean).length * SENTENCE_GAP;
  const speech = Math.max(0.1, duration - gaps - TAIL);
  const total = words.reduce((sum, word) => sum + weight(word), 0);
  let t = 0;
  return words.map((word, i) => {
    const start = t;
    const end = start + (speech * weight(word)) / total;
    t = end + (gapAfter[i] ? SENTENCE_GAP : 0);
    return { word, start, end };
  });
}

// The index of the word being spoken at time t (seconds from the start of the chunk's audio): -1 before the first
// word, words.length when the chunk is over.
export function wordAt(timings, t) {
  if (!timings.length || t < 0) return -1;
  if (t >= timings[timings.length - 1].end + SENTENCE_GAP) return timings.length;
  let at = -1;
  for (let i = 0; i < timings.length; i += 1) {
    if (timings[i].start <= t) at = i;
    else break;
  }
  return at;
}
