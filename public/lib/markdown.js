// Markdown renderer that builds DOM nodes (GFM subset). No raw HTML: all text goes through text nodes.
import { openArtifact, previewKind } from './artifact.js';
import { h } from './dom.js';
import { copyWithFeedback } from './clipboard.js';
import { highlight } from './highlight.js';
import { icon } from './icons.js';
import { agentPath } from './api.js';
import { state } from './state.js';
import { openLightbox } from './lightbox.js';
import { mountOpenUI } from './openui.js';
import { t } from './i18n.js';

function safeHttpUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// ---------- inline ----------
// Alternatives are tried left to right at each position; the earliest match wins.
const INLINE = new RegExp([
  '(`+)([\\s\\S]*?[^`])\\1(?!`)', // 1,2 code span (any number of backticks)
  '\\\\([\\\\`*_{}\\[\\]()#+\\-.!|~>])', // 3 escaped punctuation
  '\\[((?:[^\\[\\]]|\\[[^\\]]*\\])*)\\]\\(\\s*<?([^\\s)>]+)>?(?:\\s+"[^"]*")?\\s*\\)', // 4,5 link
  '<(https?:\\/\\/[^\\s>]+)>', // 6 <autolink>
  '(https?:\\/\\/[^\\s<>"\']*[^\\s<>"\'.,;:!?)\\]])', // 7 bare url
  '\\*\\*\\*(?!\\s)([\\s\\S]+?)(?<!\\s)\\*\\*\\*', // 8 bold + italic
  '\\*\\*(?!\\s)([\\s\\S]+?)(?<!\\s)\\*\\*', // 9 bold
  '(?<![\\w])__(?!\\s)([\\s\\S]+?)(?<!\\s)__(?![\\w])', // 10 bold (underscores)
  '~~(?!\\s)([\\s\\S]+?)(?<!\\s)~~', // 11 strikethrough
  '\\*(?![\\s*])([^*\\n]+?)(?<![\\s*])\\*', // 12 italic
  '(?<![\\w])_(?![\\s_])([^_\\n]+?)(?<![\\s_])_(?![\\w])', // 13 italic (underscores)
  '(?<![\\w\\)])\\[(\\d{1,3})\\](?!\\()', // 14 citation marker [1]
].join('|'), 'g');

// Set while a message the user typed is rendered: what only makes sense in an agent reply (media paths, citations, source
// lists, the openui language) stays plain text there.
let USER_MODE = false;

function renderInline(text, parent) {
  const pattern = new RegExp(INLINE.source, 'g');
  let last = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    last = pattern.lastIndex;
    if (m[2] !== undefined) {
      parent.append(h('code', {}, m[2].replace(/^ (.*[^ ].*) $/s, '$1')));
    } else if (m[3] !== undefined) {
      parent.append(m[3]);
    } else if (m[4] !== undefined) {
      const href = safeHttpUrl(m[5]);
      if (href) {
        const a = h('a', { href, target: '_blank', rel: 'noopener noreferrer' });
        renderInline(m[4], a);
        parent.append(a);
      } else {
        parent.append(m[0]);
      }
    } else if (m[6] !== undefined || m[7] !== undefined) {
      const raw = m[6] ?? m[7];
      const href = safeHttpUrl(raw);
      parent.append(href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, raw) : raw);
    } else if (m[14] !== undefined) {
      parent.append(USER_MODE ? m[0] : h('sup', { className: 'cite' }, m[14]));
    } else {
      const [tag, inner] = m[8] !== undefined ? ['strong', m[8]] : m[9] !== undefined ? ['strong', m[9]]
        : m[10] !== undefined ? ['strong', m[10]] : m[11] !== undefined ? ['del', m[11]] : ['em', m[12] ?? m[13]];
      const el = h(tag, {});
      if (m[8] !== undefined) {
        const em = h('em', {});
        renderInline(inner, em);
        el.append(em);
      } else {
        renderInline(inner, el);
      }
      parent.append(el);
    }
  }
  if (last < text.length) parent.append(text.slice(last));
}

// ---------- blocks ----------
// A visual block renders live: the renderer takes a partial program, shows the frame, and fills in as tokens arrive.
// The catch is that a streaming segment is only re-rendered when its text changed, and the closing fence arrives in a
// repaint where the block text itself did not change — so the block would be stuck on the last partial program. The
// paint loop therefore re-renders a segment while it still holds an open `openui` fence (see hasOpenVisualFence).
export function codeBlock(text, lang = '') {
  // `openui` is the model's generative-UI language: it is rendered, not shown as code.
  if (!USER_MODE && lang.toLowerCase() === 'openui') return openUIBlock(text);
  const show = (ok) => {
    button.textContent = ok === null ? t('common.copy') : ok ? t('common.copied') : t('common.copyFailed');
  };
  const button = h('button', { type: 'button', className: 'copy-btn', onClick: () => copyWithFeedback(text, show) }, t('common.copy'));
  const kind = previewKind(lang, text);
  const preview = kind ? h('button', { type: 'button', className: 'copy-btn preview-btn', 'data-testid': 'preview-btn', onClick: () => openArtifact(text, kind) }, t('artifact.preview')) : null;
  return h(
    'div',
    { className: 'code-block' },
    h('div', { className: 'code-head' }, h('span', { className: 'code-lang' }, lang || 'text'), h('span', { className: 'code-actions' }, preview, button)),
    h('pre', {}, h('code', {}, highlight(text, lang))),
  );
}

// True when a reply still has an `openui` fence that has not been closed yet: its program is incomplete, so the
// segment must be re-rendered once the closing fence lands.
export function hasOpenVisualFence(text) {
  const lines = String(text ?? '').split('\n');
  let open = false;
  for (const line of lines) {
    const fence = line.match(FENCE_OPEN);
    if (!fence) continue;
    if (!open) {
      if (fence[3].toLowerCase() === 'openui') open = true;
    } else {
      open = false;
    }
  }
  return open;
}

const SOURCE_LINE = /^\[(\d{1,3})\]\s+(https?:\/\/\S+)(?:\s+[—–-]+\s+(.+))?\s*$/;

// A rendered visual block. It mounts only once the node is in the document: a streamed reply repaints its segment
// on every token, and mounting at build time would leak a React root per repaint. The program is kept off the DOM.
const openUISources = new WeakMap(); // element -> program text
// Every mounted renderer, so the ones whose node a repaint replaced can be torn down (React keeps its own state and
// timers per root; leaving them behind leaks one root per repaint of a streaming reply).
const mountedViews = new Set();

function openUIBlock(source) {
  const el = h('div', { className: 'openui-block', 'data-testid': 'openui-block-wrap' });
  openUISources.set(el, source);
  return el;
}

// Called after a segment is painted: mount the blocks that are on screen, and hand the growing program to the ones
// that are still streaming. A repaint rebuilds the wrapper element, so the renderer that belonged to the previous
// wrapper is dropped here rather than accumulating.
//
// A view whose host ends up empty while the reply is no longer streaming is remounted from scratch: React sometimes
// settles a root that first rendered a partial program into nothing, and a fresh root with the complete program is
// both cheap and reliable. Bounded to a couple of attempts so a genuinely broken program cannot loop.
export function hydrateOpenUI(root = document, { streaming = false } = {}) {
  const blocks = [...root.querySelectorAll('.openui-block')].filter((el) => el.isConnected);
  const live = new Set(blocks);
  for (const view of [...mountedViews]) {
    if (!live.has(view.container)) {
      view.destroy();
      mountedViews.delete(view);
    }
  }
  for (const el of blocks) {
    const source = openUISources.get(el) ?? '';
    const view = el.openUIView;
    if (view && view.container === el) {
      view.update(source, { streaming });
      if (!streaming && view.isEmpty()) {
        const tries = Number(el.dataset.openuiRetry ?? 0);
        if (tries < 2) {
          el.dataset.openuiRetry = String(tries + 1);
          view.destroy();
          mountedViews.delete(view);
          delete el.openUIView;
        }
      }
      if (el.openUIView) continue;
    }
    const next = mountOpenUI(el, source, { streaming });
    if (!next) continue;
    el.openUIView = next;
    mountedViews.add(next);
  }
}

function inlineLine(text) {
  const line = h('span', { className: 'line' });
  renderInline(text.replace(/\s+$/, ''), line);
  return line;
}

function sourceLine(text) {
  const m = text.match(SOURCE_LINE);
  const href = m && safeHttpUrl(m[2]);
  if (!href) return null;
  const url = new URL(href);
  const label = m[3] ?? `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
  return h('span', { className: 'line source' }, h('sup', { className: 'cite' }, m[1]), h('a', { href, target: '_blank', rel: 'noopener noreferrer', title: href }, label));
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && TABLE_SEP.test(lines[i + 1]);

const splitRow = (line) => {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
};

const startsBlock = (lines, i) => {
  const line = lines[i];
  return FENCE_OPEN.test(line) || HEADING.test(line) || LIST_ITEM.test(line) || RULE.test(line) || QUOTE.test(line) || isTableStart(lines, i);
};

function renderTable(lines, i, root) {
  const head = splitRow(lines[i]);
  const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
  const cell = (tag, text, index) => {
    const el = h(tag, align[index] ? { className: `align-${align[index]}` } : {});
    renderInline(text, el);
    return el;
  };
  const thead = h('thead', {}, h('tr', {}, head.map((text, index) => cell('th', text, index))));
  const tbody = h('tbody', {});
  let next = i + 2;
  while (next < lines.length && lines[next].trim() !== '' && lines[next].includes('|')) {
    const cells = splitRow(lines[next]);
    tbody.append(h('tr', {}, head.map((_, index) => cell('td', cells[index] ?? '', index))));
    next += 1;
  }
  root.append(h('div', { className: 'table-wrap' }, h('table', {}, thead, tbody)));
  return next;
}

// Lists nest by indentation: an item owns the more-indented lines below it.
function renderList(lines, start, root) {
  const first = lines[start].match(LIST_ITEM);
  const ordered = /\d/.test(first[2]);
  const baseIndent = first[1].replace(/\t/g, '    ').length;
  const list = h(ordered ? 'ol' : 'ul', {});
  if (ordered && Number(first[2].match(/\d+/)[0]) !== 1) list.setAttribute('start', first[2].match(/\d+/)[0]);
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(LIST_ITEM);
    if (!m || m[1].replace(/\t/g, '    ').length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
    const body = [m[3]];
    i += 1;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') {
        const peek = lines[i + 1];
        if (peek !== undefined && /^\s+\S/.test(peek) && peek.replace(/\t/g, '    ').search(/\S/) > baseIndent) { body.push(''); i += 1; continue; }
        break;
      }
      const indent = line.replace(/\t/g, '    ').search(/\S/);
      if (indent > baseIndent) { body.push(line.replace(/\t/g, '    ').slice(Math.min(indent, baseIndent + 2))); i += 1; continue; }
      if (!startsBlock(lines, i) && !LIST_ITEM.test(line)) { body.push(line); i += 1; continue; } // lazy continuation
      break;
    }
    const li = h('li', {});
    const task = body[0].match(/^\[( |x|X)\]\s+(.*)$/);
    if (task) {
      li.className = 'task';
      li.append(h('input', { type: 'checkbox', disabled: true, checked: task[1] !== ' ' ? true : undefined, 'aria-label': task[2] }));
      body[0] = task[2];
    }
    const inner = renderBlocks(body);
    // A tight item shows its first paragraph inline instead of inside a <p>.
    if (inner.firstElementChild?.tagName === 'P' && !body.includes('')) inner.firstElementChild.replaceWith(...inner.firstElementChild.childNodes);
    li.append(...inner.childNodes);
    list.append(li);
  }
  root.append(list);
  return i;
}

function renderBlocks(lines) {
  const root = document.createDocumentFragment();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i += 1; continue; }

    const fence = line.match(FENCE_OPEN);
    if (fence) {
      const marker = fence[2];
      const code = [];
      i += 1;
      while (i < lines.length && !(lines[i].trim().startsWith(marker) && lines[i].trim().replace(new RegExp(`^${marker[0]}+`), '') === '')) {
        code.push(lines[i].startsWith(fence[1]) ? lines[i].slice(fence[1].length) : lines[i]);
        i += 1;
      }
      i += 1;
      root.append(codeBlock(code.join('\n'), fence[3]));
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const el = h(`h${Math.min(heading[1].length + 2, 6)}`, {});
      renderInline(heading[2], el);
      root.append(el);
      i += 1;
      continue;
    }

    if (RULE.test(line)) { root.append(h('hr', {})); i += 1; continue; }

    if (QUOTE.test(line)) {
      const quoted = [];
      while (i < lines.length && (QUOTE.test(lines[i]) || (lines[i].trim() !== '' && !startsBlock(lines, i) && quoted.length))) {
        quoted.push(lines[i].replace(QUOTE, '$1'));
        i += 1;
      }
      const block = h('blockquote', {});
      block.append(renderBlocks(quoted));
      root.append(block);
      continue;
    }

    if (isTableStart(lines, i)) { i = renderTable(lines, i, root); continue; }

    if (LIST_ITEM.test(line)) { i = renderList(lines, i, root); continue; }

    const paragraph = h('p', {});
    const parts = [];
    while (i < lines.length && lines[i].trim() !== '' && (parts.length === 0 || !startsBlock(lines, i))) { parts.push(lines[i]); i += 1; }
    // Models often write one thought per line: keep each line on its own row. "[1] https://… — title" lines become
    // a tidy source list.
    if (parts.length === 1 && (USER_MODE || !SOURCE_LINE.test(parts[0]))) {
      renderInline(parts[0].replace(/\s+$/, ''), paragraph);
    } else {
      for (const text of parts) paragraph.append((USER_MODE ? null : sourceLine(text)) ?? inlineLine(text));
    }
    root.append(paragraph);
  }
  return root;
}

// "MEDIA:/path/file.ext" in a reply is a file the agent produced (image, audio, video, document). It is shown inline,
// fetched through the web's own authenticated media route.
const MEDIA_EXT = 'png|jpe?g|gif|webp|bmp|mp3|wav|ogg|opus|m4a|flac|aac|mp4|webm|mov|pdf';
// Agents sometimes drop the "MEDIA:" prefix or put the path in backticks, so a bare absolute path to a media file counts too.
// Unreadable or not-allowed paths just fall back to showing the path as text.
const MEDIA_RE = new RegExp(`\`?(?:MEDIA:\\s*|(?<![\\w/.:~-]))((?:\\/|~\\/)[^\\s"'<>)\\]\`]*?\\.(?:${MEDIA_EXT}))\`?(?![\\w./-])`, 'gi');

function mediaNode(file) {
  const name = file.split('/').pop();
  const src = `${agentPath(state.agent)}/media?path=${encodeURIComponent(file)}`;
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (/^(png|jpe?g|gif|webp|bmp)$/.test(ext)) {
    const img = h('img', { className: 'md-media-img', src, alt: name, loading: 'lazy' });
    img.addEventListener('click', () => openLightbox(src, name));
    img.addEventListener('error', () => img.closest('figure')?.replaceWith(pathText(file)));
    return h('figure', { className: 'md-media', 'data-testid': 'media-image' }, img);
  }
  const player = (kind) => {
    const el = h(kind, { src, controls: true, preload: 'metadata', playsinline: kind === 'video' });
    el.addEventListener('error', () => el.closest('figure')?.replaceWith(pathText(file)));
    return h('figure', { className: 'md-media', 'data-testid': `media-${kind}` }, el, h('figcaption', {}, name, ' · ', h('a', { href: src, download: name }, t('artifact.download'))));
  };
  if (/^(mp3|wav|ogg|opus|m4a|flac|aac)$/.test(ext)) return player('audio');
  if (/^(mp4|webm|mov)$/.test(ext)) return player('video');
  return downloadChip(src, name);
}

const pathText = (file) => h('p', { className: 'md-media-missing' }, h('code', {}, file));

const downloadChip = (src, name) => h('a', { className: 'md-media-file', href: src, download: name, 'data-testid': 'media-file' }, icon('file', 16), h('span', {}, name));

export function renderMarkdown(source, { user = false } = {}) {
  const root = h('div', { className: user ? 'md markdown-body md-user' : 'md markdown-body' });
  const text = String(source ?? '').replace(/\r\n?/g, '\n');
  USER_MODE = user;
  try {
    return renderParts(root, user ? [text] : text.split(MEDIA_RE));
  } finally {
    USER_MODE = false;
  }
}

function renderParts(root, parts) {
  // split() with one capture group alternates text, file, text, file, …
  parts.forEach((part, index) => {
    if (index % 2) root.append(mediaNode(part));
    else if (part.trim()) root.append(renderBlocks(part.split('\n')));
  });
  return root;
}
