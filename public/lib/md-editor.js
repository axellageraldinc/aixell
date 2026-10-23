// Markdown help while typing in the composer: lists keep numbering and bullets going, Tab / Shift+Tab nest and un-nest
// items (and indent inside code), a ``` line opens a code block that closes itself, quotes continue, and Ctrl+B / Ctrl+I
// wrap the selection. Plain text is left alone, and Tab only does this where it would otherwise do nothing useful, so
// keyboard users can still tab out of the box. A preview button shows the draft rendered the way the bubble will show it.
import { h } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { t } from './i18n.js';

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?/;
const QUOTE = /^(\s*(?:>[ \t]?)+)/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const FENCE_OPENER = /^(\s*)(`{3,}|~{3,})[\w+#.-]*\s*$/;
const PREVIEW_KEY = 'hermes.mdpreview';

const lineStart = (v, pos) => v.lastIndexOf('\n', pos - 1) + 1;
const lineEnd = (v, pos) => { const i = v.indexOf('\n', pos); return i === -1 ? v.length : i; };
const isOrdered = (marker) => /\d/.test(marker);

// Is `pos` inside a fenced code block? Fences on the lines above are counted; a closing fence line itself is outside.
function inFence(v, pos) {
  let open = null;
  for (const line of v.slice(0, lineStart(v, pos)).split('\n')) {
    const m = FENCE.exec(line);
    if (!m) continue;
    if (open === null) open = m[1][0];
    else if (m[1][0] === open && /^\s*(`{3,}|~{3,})\s*$/.test(line)) open = null;
  }
  if (open === null) return false;
  const current = v.slice(lineStart(v, pos), lineEnd(v, pos));
  return !(FENCE.test(current) && /^\s*(`{3,}|~{3,})\s*$/.test(current) && current.trim()[0] === open);
}

export function initMarkdownEditor({ input, enterNewlines }) {
  // Replaces [start, end) through the editing command when possible, so Ctrl+Z still undoes it.
  function edit(start, end, text, caret = null) {
    input.setSelectionRange(start, end);
    let done = false;
    try { done = document.execCommand('insertText', false, text); } catch { /* fall back below */ }
    if (!done) {
      input.setRangeText(text, start, end, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (caret !== null) input.setSelectionRange(caret, caret);
  }
  const handled = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };

  function onEnter(event) {
    const v = input.value;
    const s = input.selectionStart;
    const e = input.selectionEnd;
    const before = v.slice(lineStart(v, s), s);
    const inside = inFence(v, s);
    const indent = before.match(/^\s*/)[0];

    // "```js" + Enter opens a block and closes it for you (never sends the message).
    const opener = FENCE_OPENER.exec(before);
    if (opener && !inside && s === e && v.slice(s, lineEnd(v, s)).trim() === '' && !v.slice(s).split('\n').some((l) => FENCE.test(l))) {
      edit(s, e, `\n${indent}\n${indent}${opener[2]}`, s + 1 + indent.length);
      return handled(event);
    }
    // Enter sends on a keyboard; a new line is Shift+Enter, Enter on a phone, or any Enter inside a code block.
    if (!(enterNewlines() || event.shiftKey || inside)) return;

    if (inside) {
      edit(s, e, `\n${indent}${/[{(\[:]\s*$/.test(before) ? '  ' : ''}`);
      return handled(event);
    }
    const item = LIST.exec(before);
    if (item) {
      const rest = before.slice(item[0].length);
      if (rest.trim() === '' && s === e) {
        // Empty item: Enter ends the list (or steps one level out of a nested one).
        const ls = lineStart(v, s);
        const outIndent = item[1].length > 0 ? ' '.repeat(Math.max(0, item[1].length - (isOrdered(item[2]) ? 3 : 2))) : null;
        if (outIndent === null) edit(ls, s, '', ls);
        else edit(ls, s, `${outIndent}${item[2]}${item[3]}${item[4] ?? ''}`);
        return handled(event);
      }
      const marker = isOrdered(item[2]) ? `${parseInt(item[2], 10) + 1}${item[2].slice(-1)}` : item[2];
      edit(s, e, `\n${item[1]}${marker}${item[3]}${item[4] ? '[ ] ' : ''}`);
      return handled(event);
    }
    const quote = QUOTE.exec(before);
    if (quote) {
      if (before.slice(quote[0].length).trim() === '' && s === e) edit(lineStart(v, s), s, '', lineStart(v, s));
      else edit(s, e, `\n${quote[1]}`);
      return handled(event);
    }
    if (indent) { edit(s, e, `\n${indent}`); return handled(event); }
  }

  // Where a list item should sit when indented: right under the text of the closest item above that is not deeper.
  function nestedIndent(lines, index) {
    const own = lines[index].match(/^\s*/)[0].length;
    for (let i = index - 1; i >= 0; i -= 1) {
      const m = LIST.exec(lines[i]);
      if (m && m[1].length <= own) return m[1].length + m[2].length + m[3].length;
      if (m && m[1].length > own) continue;
    }
    return own + 2;
  }
  function outdentedIndent(lines, index) {
    const own = lines[index].match(/^\s*/)[0].length;
    for (let i = index - 1; i >= 0; i -= 1) {
      const m = LIST.exec(lines[i]);
      if (m && m[1].length < own) return m[1].length;
    }
    return 0;
  }
  // The number an ordered item should carry at `indentLen`: one more than the item above at that level, else 1.
  function numberAt(lines, index, indentLen) {
    for (let i = index - 1; i >= 0; i -= 1) {
      const m = LIST.exec(lines[i]);
      if (!m) continue;
      if (m[1].length < indentLen) return 1;
      if (m[1].length === indentLen && isOrdered(m[2])) return parseInt(m[2], 10) + 1;
    }
    return 1;
  }

  function onTab(event) {
    const v = input.value;
    const s = input.selectionStart;
    const e = input.selectionEnd;
    const multi = v.slice(s, e).includes('\n');
    const first = lineStart(v, s);
    const current = v.slice(first, lineEnd(v, s));
    const inside = inFence(v, s);
    if (!(multi || LIST.test(current) || inside)) return; // plain text: Tab keeps moving focus
    handled(event);
    if (inside && !multi && !LIST.test(current)) {
      if (!event.shiftKey) return edit(s, e, '  ', s + 2);
      const lead = Math.min(2, current.match(/^ */)[0].length);
      return lead ? edit(first, first + lead, '', Math.max(first, s - lead)) : undefined;
    }
    const last = lineEnd(v, e > s && v[e - 1] === '\n' ? e - 1 : e);
    const above = v.slice(0, first).split('\n');
    const lines = v.slice(first, last).split('\n');
    const all = [...above, ...lines];
    const base = above.length;
    const out = lines.map((line, k) => {
      const idx = base + k;
      const m = LIST.exec(all[idx]);
      const own = line.match(/^ */)[0].length;
      if (!m) return event.shiftKey ? line.replace(/^ {1,2}/, '') : (inside ? `  ${line}` : line);
      const target = event.shiftKey ? outdentedIndent(all, idx) : nestedIndent(all, idx);
      let fixed = `${' '.repeat(target)}${line.slice(own)}`;
      if (isOrdered(m[2])) fixed = fixed.replace(/^(\s*)\d{1,9}/, `$1${numberAt(all, idx, target)}`);
      all[idx] = fixed;
      return fixed;
    });
    const text = out.join('\n');
    const delta = text.length - (last - first);
    edit(first, last, text);
    if (multi) input.setSelectionRange(first, first + text.length);
    else input.setSelectionRange(Math.max(first, s + (out[0].length - lines[0].length)), Math.max(first, e + (out[0].length - lines[0].length)));
    return delta;
  }

  function wrap(marker) {
    const s = input.selectionStart;
    const e = input.selectionEnd;
    const picked = input.value.slice(s, e);
    if (picked) { edit(s, e, `${marker}${picked}${marker}`); input.setSelectionRange(s + marker.length, e + marker.length); } else edit(s, e, marker + marker, s + marker.length);
  }

  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) return onEnter(event);
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) return onTab(event);
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && (event.key === 'b' || event.key === 'i')) { handled(event); wrap(event.key === 'b' ? '**' : '*'); return; }
    if (event.key === '`' && input.selectionStart !== input.selectionEnd && !event.ctrlKey && !event.metaKey) { handled(event); wrap('`'); }
  }, true);

  // A link pasted over selected text becomes [text](link).
  input.addEventListener('paste', (event) => {
    const s = input.selectionStart;
    const e = input.selectionEnd;
    const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
    if (s === e || !/^https?:\/\/\S+$/.test(text) || input.value.slice(s, e).includes('\n')) return;
    event.preventDefault();
    edit(s, e, `[${input.value.slice(s, e)}](${text})`);
  });
}

// ----- live preview of the draft -----
export function initMarkdownPreview({ input, button, form }) {
  const body = h('div', { className: 'md-preview-body' });
  const box = h('div', { className: 'md-preview', hidden: true, 'data-testid': 'md-preview', 'aria-label': t('composer.preview.label') }, h('div', { className: 'md-preview-label' }, t('composer.preview')), body);
  form.insertBefore(box, input);
  let on = false;
  let shown = null;
  try { on = localStorage.getItem(PREVIEW_KEY) === '1'; } catch { /* default off */ }

  const paint = () => {
    const text = input.value;
    box.hidden = !on || text.trim() === '';
    if (box.hidden || text === shown) return;
    shown = text;
    body.replaceChildren(renderMarkdown(text, { user: true }));
  };
  const set = (next) => {
    on = next;
    button.setAttribute('aria-pressed', String(on));
    button.classList.toggle('is-on', on);
    try { localStorage.setItem(PREVIEW_KEY, on ? '1' : '0'); } catch { /* this page only */ }
    shown = null;
    paint();
  };
  button.addEventListener('click', () => set(!on));
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); set(!on); }
  });
  input.addEventListener('input', paint);
  // The box is also emptied or filled by code (sending, switching chats): look again now and then.
  setInterval(paint, 400);
  set(on);
}
