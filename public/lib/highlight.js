// Tiny syntax highlighter for chat code blocks: it only colours tokens (comments, strings, numbers, keywords,
// function calls) and never parses. Unknown languages stay plain. Output is DOM nodes, never HTML.
import { h } from './dom.js';

const MAX_CHARS = 20_000;

const C_LIKE = new Set('const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof in of this super null undefined true false interface type enum implements public private protected static readonly void yield delete abstract final int long double float boolean char byte short string bool package fn mut pub struct impl use match func go defer chan map range nil self trait where unsafe mod crate throws val fun object when is as override open data sealed lateinit'.split(' '));
const PYTHON = new Set('def class return if elif else for while in not and or is import from as with try except finally raise lambda pass break continue yield None True False async await global nonlocal assert del self cls print'.split(' '));
const SHELL = new Set('if then else elif fi for while do done case esac function in echo cd export local return exit sudo set unset source alias test read shift trap eval exec'.split(' '));
const SQL = new Set('select from where join left right inner outer full cross on group by order limit offset insert into values update set delete create table alter drop index view and or not null as distinct having union all case when then else end count sum avg min max like in is between exists primary key foreign references default unique'.split(' '));
const DATA = new Set(['true', 'false', 'null']);

const COMMENTS = {
  slash: String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`,
  hash: String.raw`#[^\n]*`,
  dash: String.raw`--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`,
  block: String.raw`<!--[\s\S]*?(?:-->|$)`,
  css: String.raw`\/\*[\s\S]*?(?:\*\/|$)`,
};
const DQ = String.raw`"(?:\\.|[^"\\\n])*"?`;
const SQ = String.raw`'(?:\\.|[^'\\\n])*'?`;
const BT = String.raw`\x60(?:\\[\s\S]|[^\x60\\])*\x60?`;
const TRIPLE = String.raw`"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)`;

// family -> { comment, strings, words, caseless }
const FAMILIES = {
  js: { comment: COMMENTS.slash, strings: [DQ, SQ, BT], words: C_LIKE },
  clike: { comment: COMMENTS.slash, strings: [DQ, SQ], words: C_LIKE },
  go: { comment: COMMENTS.slash, strings: [DQ, SQ, BT], words: C_LIKE },
  python: { comment: COMMENTS.hash, strings: [TRIPLE, DQ, SQ], words: PYTHON },
  shell: { comment: COMMENTS.hash, strings: [DQ, SQ], words: SHELL },
  yaml: { comment: COMMENTS.hash, strings: [DQ, SQ], words: DATA },
  json: { comment: '', strings: [DQ], words: DATA },
  sql: { comment: COMMENTS.dash, strings: [SQ, DQ], words: SQL, caseless: true },
  css: { comment: COMMENTS.css, strings: [DQ, SQ], words: new Set() },
  markup: { comment: COMMENTS.block, strings: [DQ, SQ], words: new Set(), markup: true },
};
const ALIASES = {
  js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', ts: 'js', typescript: 'js', tsx: 'js',
  java: 'clike', c: 'clike', cpp: 'clike', 'c++': 'clike', cs: 'clike', csharp: 'clike', rust: 'clike', rs: 'clike', kotlin: 'clike', kt: 'clike', swift: 'clike', php: 'clike', scala: 'clike', dart: 'clike',
  go: 'go', golang: 'go',
  py: 'python', python: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell', dockerfile: 'shell', toml: 'yaml', ini: 'yaml', env: 'yaml',
  yaml: 'yaml', yml: 'yaml',
  json: 'json', jsonc: 'json',
  sql: 'sql', postgresql: 'sql', mysql: 'sql',
  css: 'css', scss: 'css',
  html: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
};
const compiled = new Map();

function compile(name) {
  if (!compiled.has(name)) {
    const f = FAMILIES[name];
    const strings = f.strings.join('|');
    // One capture group per kind, in this order: comment, string, tag, number, word.
    const groups = [f.comment ? `(${f.comment})` : '((?!))', `(${strings})`, f.markup ? String.raw`(<\/?[A-Za-z][\w:-]*)` : '((?!))', String.raw`(\b0x[\da-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)`, String.raw`([A-Za-z_$][\w$]*)`];
    compiled.set(name, { re: new RegExp(groups.join('|'), 'g') });
  }
  return compiled.get(name);
}

const span = (kind, text) => h('span', { className: `hl-${kind}` }, text);

export function highlight(code, lang = '') {
  const name = ALIASES[String(lang).toLowerCase()];
  if (!name || code.length > MAX_CHARS) return code;
  const family = FAMILIES[name];
  const { re } = compile(name);
  const out = document.createDocumentFragment();
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m[0] === '') { re.lastIndex += 1; continue; }
    if (m.index > last) out.append(code.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) out.append(span('c', m[0]));
    else if (m[2]) out.append(span(name === 'json' && /^\s*:/.test(code.slice(last, last + 8)) ? 'a' : 's', m[0]));
    else if (m[3]) out.append(span('t', m[0]));
    else if (m[4]) out.append(span('n', m[0]));
    else {
      const word = family.caseless ? m[5].toLowerCase() : m[5];
      if (family.words.has(word)) out.append(span('k', m[5]));
      else if (code[last] === '(' && name !== 'json') out.append(span('f', m[5]));
      else out.append(m[5]);
    }
  }
  if (last < code.length) out.append(code.slice(last));
  return out;
}
