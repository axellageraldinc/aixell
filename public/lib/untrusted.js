// Text that came from the internet (a story title, a link) and is about to be written into a chat message the owner will
// send to an agent that has tools. It must not be able to carry instructions: control and invisible characters are removed,
// the text becomes one short line, and only plain http(s) links pass.
// Ranges are code points, spelled as numbers so the source holds no invisible characters: C0/C1 controls, soft hyphen, Arabic
// letter mark, Hangul fillers, Mongolian vowel separator, zero-width and bidi marks, word joiner and invisible operators,
// variation selectors, BOM, specials and the Unicode tag block.
const RANGES = [[0, 31], [127, 159], [173, 173], [1564, 1564], [4447, 4448], [6068, 6069], [6158, 6158], [8203, 8207], [8232, 8238], [8288, 8303], [12644, 12644], [65024, 65039], [65279, 65279], [65440, 65440], [65529, 65531], [917504, 917631]];
const INVISIBLE = new RegExp(`[${RANGES.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('')}]`, 'gu');

export function plainLine(text, max = 200) {
  const line = String(text ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function plainHttpUrl(raw, max = 500) {
  try {
    const url = new URL(String(raw ?? '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    const href = url.href.replace(INVISIBLE, '');
    return href.length > max ? '' : href;
  } catch { return ''; }
}

// A fenced block the agent is told to treat as data. The fence cannot appear inside the text because plainLine keeps one line
// and the backticks are replaced.
export function untrustedBlock({ title, url }, notice) {
  const safeTitle = plainLine(title).replace(/`/g, "'");
  const safeUrl = plainHttpUrl(url);
  return `${notice}\n\`\`\`untrusted-story\n${safeTitle}${safeUrl ? `\n${safeUrl}` : ''}\n\`\`\``;
}
