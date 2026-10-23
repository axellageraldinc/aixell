// Preview panel: runs an HTML / SVG block from a reply in a sandboxed frame next to the chat. The markup goes to the
// server once; the frame loads it from /artifact/<id>, which answers with a CSP that isolates it from the app.
import { h } from './dom.js';
import { api } from './api.js';
import { icon } from './icons.js';
import { notify } from './ui.js';
import { t } from './i18n.js';

let panel = null;
let frameBox = null;
let titleEl = null;
let openLink = null;
let current = null; // { code, kind }

function ensure() {
  if (panel) return;
  const close = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('artifact.preview.close'), 'data-testid': 'artifact-close', onClick: closeArtifact }, icon('x', 18));
  const reload = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('artifact.rerun'), title: t('artifact.rerun'), onClick: () => current && show(current.code, current.kind) }, icon('refresh', 18));
  const save = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('artifact.download'), title: t('artifact.download'), onClick: download }, icon('download', 18));
  openLink = h('a', { className: 'btn btn-sm', target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'artifact-open' }, t('artifact.openTab'));
  titleEl = h('h2', {}, t('artifact.preview'));
  frameBox = h('div', { className: 'artifact-frame' });
  panel = h('aside', { className: 'artifact', 'data-testid': 'artifact', 'aria-label': t('artifact.preview'), hidden: true },
    h('header', { className: 'artifact-head' }, titleEl, h('span', { className: 'dlg-spacer' }), openLink, reload, save, close), frameBox);
  document.body.append(panel);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !panel.hidden && !document.querySelector('.dlg')) closeArtifact(); });
}

function download() {
  if (!current) return;
  const type = current.kind === 'svg' ? 'image/svg+xml' : 'text/html';
  const url = URL.createObjectURL(new Blob([current.code], { type: `${type};charset=utf-8` }));
  const a = h('a', { href: url, download: current.kind === 'svg' ? t('artifact.filename.svg') : t('artifact.filename.html') });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function show(code, kind) {
  current = { code, kind };
  try {
    const { id } = await api('/api/artifacts', { method: 'POST', body: { code, kind } });
    const frame = h('iframe', { className: 'artifact-iframe', src: `/artifact/${id}`, title: t('artifact.preview'), 'data-testid': 'artifact-frame', referrerpolicy: 'no-referrer' });
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
    frameBox.replaceChildren(frame);
    openLink.href = `/artifact/${id}`;
  } catch (err) {
    frameBox.replaceChildren(h('p', { className: 'dlg-note' }, err.message));
    notify(err.message);
  }
}

export function openArtifact(code, kind) {
  ensure();
  titleEl.textContent = kind === 'svg' ? t('artifact.preview.svg') : t('artifact.preview.html');
  panel.hidden = false;
  document.body.classList.add('artifact-open');
  return show(code, kind);
}

export function closeArtifact() {
  if (!panel) return;
  panel.hidden = true;
  document.body.classList.remove('artifact-open');
  frameBox.replaceChildren();
}

// Which fenced languages get a preview button.
export function previewKind(lang, text) {
  const l = String(lang ?? '').toLowerCase();
  if (l === 'svg' || (l === 'xml' && /^\s*<svg[\s>]/i.test(text))) return 'svg';
  if (l === 'html' || l === 'htm') return 'html';
  return null;
}
