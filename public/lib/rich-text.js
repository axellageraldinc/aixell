// Inline formatting for the story card, written as plain-text markers so it survives editing, the AI and the server:
//   **bold**   *italic*   __underline__   ~~strikethrough~~
// A marker only formats when its closing twin follows; a lone one is shown as typed. The parser has no DOM
// dependency; layout and drawing take a canvas 2D context.
const TOKENS = [['**', 'b'], ['__', 'u'], ['~~', 's'], ['*', 'i']];

// text -> [{ text, b, i, u, s }]
export function parseInline(text, style = {}) {
  const runs = [];
  let plain = '';
  const flush = () => { if (plain) { runs.push({ text: plain, b: false, i: false, u: false, s: false, ...style }); plain = ''; } };
  const src = String(text ?? '');
  for (let i = 0; i < src.length;) {
    const hit = TOKENS.find(([mark]) => src.startsWith(mark, i));
    if (hit) {
      const [mark, flag] = hit;
      // As in Markdown, the markers must touch the words they format: "5 * 3 and 4 * 5" is arithmetic, not italics.
      let end = src.indexOf(mark, i + mark.length);
      while (end > -1 && (end === i + mark.length || /\s/.test(src[i + mark.length]) || /\s/.test(src[end - 1]))) end = src.indexOf(mark, end + 1);
      if (end > -1) {
        flush();
        runs.push(...parseInline(src.slice(i + mark.length, end), { ...style, [flag]: true }));
        i = end + mark.length;
        continue;
      }
    }
    plain += src[i];
    i += 1;
  }
  flush();
  return runs;
}

// What the text says with the markers taken out (for lengths and tests).
export const visibleText = (text) => parseInline(text).map((r) => r.text).join('');

export const fontOf = (style, size, weight) => `${style.i ? 'italic ' : ''}${style.b ? Math.max(weight, 800) : weight} ${size}px`;

// Greedy word wrap over styled runs. -> lines: [[{ text, b, i, u, s }]]; neighbours with the same style are merged, spaces
// included, so an underline runs unbroken under a phrase. A word wider than the line is broken by letters.
export function wrapRich(ctx, text, maxWidth, size, weight, family) {
  const measure = (str, style) => { ctx.font = `${fontOf(style, size, weight)} ${family}`; return ctx.measureText(str).width; };
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = [];
    let x = 0;
    const push = (str, style) => {
      const last = line[line.length - 1];
      if (last && last.b === style.b && last.i === style.i && last.u === style.u && last.s === style.s) last.text += str;
      else line.push({ ...style, text: str });
    };
    const newline = () => { lines.push(line); line = []; x = 0; };
    let pendingSpace = null; // the style of a space waiting to be placed before the next word
    for (const run of parseInline(para)) {
      for (const part of run.text.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { pendingSpace = run; continue; }
        const space = line.length && pendingSpace ? measure(' ', pendingSpace) : 0;
        const width = measure(part, run);
        if (line.length && x + space + width > maxWidth) newline();
        else if (line.length && pendingSpace) { push(' ', { ...pendingSpace, u: pendingSpace.u && run.u, s: pendingSpace.s && run.s }); x += space; }
        pendingSpace = null;
        let word = part;
        while (measure(word, run) > maxWidth && word.length > 1) {
          let n = word.length - 1;
          while (n > 1 && measure(word.slice(0, n), run) > maxWidth) n -= 1;
          push(word.slice(0, n), run);
          newline();
          word = word.slice(n);
        }
        push(word, run);
        x += measure(word, run);
      }
    }
    lines.push(line);
  }
  return lines;
}

// Draws one wrapped line from (x, baseline). The underline is a thick, bright bar under the baseline so it stands out on the dark
// card; the strikethrough is a thinner line through the middle of the letters in the text colour.
export function drawRichLine(ctx, line, x, baseline, { size, weight, family, color, underline = '#ffd23f' }) {
  let cx = x;
  for (const seg of line) {
    ctx.font = `${fontOf(seg, size, weight)} ${family}`;
    ctx.fillStyle = color;
    ctx.fillText(seg.text, cx, baseline);
    const w = ctx.measureText(seg.text).width;
    if (seg.u) {
      const thick = Math.max(4, Math.round(size * 0.09));
      ctx.fillStyle = underline;
      ctx.beginPath();
      ctx.roundRect(cx, baseline + Math.round(size * 0.14), w, thick, thick / 2);
      ctx.fill();
    }
    if (seg.s) {
      const thick = Math.max(3, Math.round(size * 0.06));
      ctx.fillStyle = color;
      ctx.fillRect(cx, baseline - Math.round(size * 0.3), w, thick);
    }
    cx += w;
  }
}

// Wraps the selected part of a textarea in a marker (or takes it off when it is already there).
export function toggleMarker(field, mark) {
  const { value, selectionStart: a, selectionEnd: b } = field;
  const inside = value.slice(a, b);
  const wrapped = value.slice(a - mark.length, a) === mark && value.slice(b, b + mark.length) === mark;
  if (wrapped) {
    field.value = value.slice(0, a - mark.length) + inside + value.slice(b + mark.length);
    field.setSelectionRange(a - mark.length, b - mark.length);
  } else if (inside.startsWith(mark) && inside.endsWith(mark) && inside.length >= mark.length * 2) {
    field.value = value.slice(0, a) + inside.slice(mark.length, -mark.length) + value.slice(b);
    field.setSelectionRange(a, b - mark.length * 2);
  } else {
    field.value = value.slice(0, a) + mark + inside + mark + value.slice(b);
    // With nothing selected the caret goes between the markers, ready to type.
    field.setSelectionRange(a + mark.length, b + mark.length);
  }
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.focus();
}
