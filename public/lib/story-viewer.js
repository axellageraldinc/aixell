// Story viewer of the Feed home: tapping a circle opens a quick look at that chat's latest reply (read it, copy it, jump to the
// chat) without leaving the feed, and you can move on to the next circle. Posts below open the chat itself, so the two do
// different jobs. No auto-advance: a reply is read at your own pace; the bars only show where you are.
import { h } from './dom.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { t } from './i18n.js';

const SWIPE_PX = 60;
const MAX_BARS = 12; // with more chats than this the bars would be slivers: a counter ("3/30") says where you are

// items: [{ id, title, time, running }]; load(id) -> Promise<{ text, cover }>; callbacks: onOpen(id), onSeen(id), onCopy(text)
export function openStoryViewer({ items, start = 0, load, onOpen, onSeen, onCopy, onClose }) {
  if (!items.length) return;
  let index = Math.min(Math.max(start, 0), items.length - 1);
  let token = 0;
  const opener = document.activeElement;

  const bars = h('div', { className: 'fh-v-bars', 'aria-hidden': 'true', hidden: items.length > MAX_BARS }, items.map(() => h('span', { className: 'fh-v-bar' })));
  const face = h('span', { className: 'fh-av fh-v-face' });
  const title = h('b', { className: 'fh-v-title' });
  const when = h('small', { className: 'fh-v-when' });
  const close = h('button', { type: 'button', className: 'ibtn fh-v-close', 'aria-label': t('common.close'), title: t('common.close') + ' (Esc)' }, icon('x', 20));
  const body = h('div', { className: 'fh-v-body', tabindex: '0' });
  const copy = h('button', { type: 'button', className: 'btn btn-sm fh-v-copy' }, icon('copy', 16), t('common.copy'));
  const go = h('button', { type: 'button', className: 'btn btn-sm btn-primary fh-v-go', 'data-testid': 'story-open' }, t('feed.story.openChat'), icon('chevron-right', 16));
  const prev = h('button', { type: 'button', className: 'fh-v-arrow fh-v-prev', 'aria-label': t('feed.story.prev') }, icon('chevron-right', 22));
  const next = h('button', { type: 'button', className: 'fh-v-arrow fh-v-next', 'aria-label': t('feed.story.next') }, icon('chevron-right', 22));
  const card = h('div', { className: 'fh-v-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('feed.story.label'), 'data-testid': 'story-viewer' },
    bars,
    h('div', { className: 'fh-v-head' }, face, h('span', { className: 'fh-v-who' }, title, when), close),
    body,
    h('div', { className: 'fh-v-foot' }, copy, go));
  const overlay = h('div', { className: 'fh-viewer' }, prev, card, next);

  let lastText = '';
  async function show(i) {
    index = i;
    const item = items[index];
    const mine = ++token;
    bars.querySelectorAll('.fh-v-bar').forEach((bar, n) => bar.classList.toggle('is-done', n <= index));
    prev.hidden = index === 0;
    next.hidden = index === items.length - 1;
    face.textContent = (item.title.trim()[0] ?? 'a').toUpperCase();
    face.replaceChildren(face.textContent);
    title.textContent = item.title;
    const place = items.length > MAX_BARS ? `${index + 1}/${items.length} · ` : '';
    when.textContent = `${place}${item.running ? t('feed.story.replying') : item.time}`;
    body.scrollTop = 0;
    body.replaceChildren(h('p', { className: 'fh-v-note' }, t('common.loading')));
    onSeen?.(item.id);
    let got = null;
    try { got = await load(item.id); } catch { /* shown as "no reply" below */ }
    if (mine !== token) return;
    lastText = got?.text ?? '';
    if (got?.cover) face.replaceChildren(h('img', { src: got.cover, alt: '' }));
    body.replaceChildren(...(lastText ? [renderMarkdown(lastText)] : [
      h('p', { className: 'fh-v-note' }, t('feed.story.noText')),
      got?.ask ? h('div', { className: 'fh-v-ask' }, h('small', {}, t('feed.story.lastQuestion')), h('p', {}, got.ask)) : null,
    ]));
    copy.disabled = !lastText;
  }

  const step = (n) => { const to = index + n; if (to >= 0 && to < items.length) show(to); };
  const shut = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    document.documentElement.classList.remove('fh-viewing');
    onClose?.();
    opener?.focus?.();
  };
  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); shut(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
  }
  close.addEventListener('click', shut);
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) shut(); });
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  copy.addEventListener('click', () => onCopy?.(lastText));
  // The chat is opened first and the viewer closed after: closing first lets the viewer's own history entry be taken away again
  // after the chat's address was written (Back-nav), which sent a phone straight back to the home feed.
  go.addEventListener('click', () => { const id = items[index].id; onOpen?.(id); shut(); });

  // Phone: swipe sideways to move between chats (the text itself scrolls up and down).
  let from = null;
  card.addEventListener('touchstart', (event) => { const touch = event.touches[0]; from = event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : null; }, { passive: true });
  card.addEventListener('touchend', (event) => {
    if (!from) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - from.x;
    const dy = touch.clientY - from.y;
    from = null;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dy) < Math.abs(dx) * 0.6) step(dx < 0 ? 1 : -1);
  }, { passive: true });

  document.addEventListener('keydown', onKey, true);
  document.documentElement.classList.add('fh-viewing');
  document.body.append(overlay);
  show(index);
  go.focus();
}
