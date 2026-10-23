// Reads a Fresh story in place: the page's text without menus, ads and trackers (cleaned by the server), a small bar to ask
// the app about it, save it, or open the original. Looks like the story viewer, and Back / Esc close it.
import { h } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { notify } from './ui.js';
import { agoShort } from './fresh-feed.js';
import { signal } from './fresh-signals.js';
import { t } from './i18n.js';
import { state } from './state.js';
import { agentLabel } from './format.js';

function blockNode(block) {
  if (block.k === 'h') return h('h3', {}, block.t);
  if (block.k === 'li') return h('p', { className: 'fr-r-li' }, block.t);
  if (block.k === 'q') return h('blockquote', {}, block.t);
  if (block.k === 'code') return h('pre', {}, block.t);
  return h('p', {}, block.t);
}

export function openReader({ id, item, ask, onSave }) {
  const opener = document.activeElement;
  const close = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('common.close'), title: `${t('common.close')} (Esc)` }, icon('x', 20));
  const body = h('div', { className: 'fr-r-body', tabindex: '0' });
  const save = h('button', { type: 'button', className: 'btn btn-sm fr-r-save', 'aria-pressed': String(item.saved) }, icon('bookmark', 16), h('span', {}, item.saved ? t('common.saved') : t('common.save')));
  const source = h('a', { className: 'btn btn-sm', href: item.url, target: '_blank', rel: 'noopener noreferrer', onClick: () => signal(id, 'open') }, icon('external-link', 16), t('feed.reader.source'));
  const tanya = h('button', { type: 'button', className: 'btn btn-sm btn-primary', 'data-testid': 'reader-ask' }, icon('message-circle', 16), t('feed.reader.ask', { agent: agentLabel(state.agent) }));
  const card = h('div', { className: 'fh-v-card fr-r-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': item.title, 'data-testid': 'fresh-reader' },
    h('div', { className: 'fh-v-head' },
      h('span', { className: 'fh-av fh-v-face' }, (item.sourceName[0] ?? '?').toUpperCase()),
      h('span', { className: 'fh-v-who' }, h('b', { className: 'fh-v-title' }, item.sourceName), h('small', { className: 'fh-v-when' }, `${agoShort(item.ts)} · ${item.catLabel}`)),
      close),
    body,
    h('div', { className: 'fh-v-foot fr-r-foot' }, tanya, save, source));
  const overlay = h('div', { className: 'fh-viewer fr-reader' }, card);

  // Time spent here (only while the page is visible) goes to the server when the reader closes; reaching the end of the text is a
  // stronger signal of its own.
  let shown = 0;
  let since = performance.now();
  let sentRead = false;
  const tick = () => { if (since) { shown += performance.now() - since; since = 0; } };
  const onVis = () => { if (document.visibilityState === 'visible') since = performance.now(); else tick(); };
  document.addEventListener('visibilitychange', onVis);
  let loaded = false;
  body.addEventListener('scroll', () => {
    if (sentRead || !loaded || body.scrollHeight <= body.clientHeight + 40) return;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 120) { sentRead = true; signal(id, 'read'); }
  }, { passive: true });

  const shut = () => {
    tick();
    document.removeEventListener('visibilitychange', onVis);
    if (shown >= 1500) signal(id, 'dwell', shown);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    document.documentElement.classList.remove('fh-viewing');
    opener?.focus?.();
  };
  const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); shut(); } };
  close.addEventListener('click', shut);
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) shut(); });
  tanya.addEventListener('click', () => { signal(id, 'ask'); shut(); ask(item); });
  save.addEventListener('click', async () => {
    const next = save.getAttribute('aria-pressed') !== 'true';
    save.setAttribute('aria-pressed', String(next));
    save.lastChild.textContent = next ? t('common.saved') : t('common.save');
    onSave?.(next);
    if (next) signal(id, 'save');
    try { await api(`/api/fresh/${id}/${next ? 'save' : 'unsave'}`, { method: 'POST' }); } catch { notify(t('feed.reader.saveFailed')); }
  });

  const head = [
    item.image ? h('img', { className: 'fr-r-hero', src: item.image, alt: '' }) : null,
    h('h2', { className: 'fr-r-title' }, item.title),
    item.summary ? h('p', { className: 'fr-r-lede' }, item.summary) : null,
    item.why ? h('p', { className: 'fr-why' }, h('b', {}, t('feed.reader.why')), ' ', item.why) : null,
  ].filter(Boolean); // replaceChildren would print a null as the text "null"
  const note = (text) => h('p', { className: 'fh-v-note' }, text);
  body.replaceChildren(...head, note(t('feed.reader.loading')));

  document.addEventListener('keydown', onKey, true);
  document.documentElement.classList.add('fh-viewing');
  document.body.append(overlay);
  tanya.focus();

  api(`/api/fresh/${id}/reader`).then((res) => {
    if (!overlay.isConnected) return;
    loaded = true;
    const blocks = (res.blocks ?? []).filter((b) => !(b.k === 'h' && b.t.trim().toLowerCase() === item.original?.trim().toLowerCase()));
    const readable = blocks.filter((b) => b.k === 'p').length >= 2;
    body.replaceChildren(...head, h('hr', { className: 'fr-r-rule' }),
      ...(readable ? blocks.map(blockNode) : [note(t('feed.reader.noContent'))]));
    if (res.translated === false && readable) body.append(note(t('feed.reader.untranslated')));
  }).catch(() => {
    if (overlay.isConnected) body.replaceChildren(...head, note(t('feed.reader.loadFailed')));
  });
}
