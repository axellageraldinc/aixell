// "Feed" interface style: every turn (your message + the reply) is one full-height page, moved through by swiping or
// scrolling. The DOM is the normal chat; this only measures pages, keeps a small rail of actions, and marks nodes.
import { h, $ } from './dom.js';
import { icon } from './icons.js';
import { state, on } from './state.js';
import { releaseFollow } from './scroll.js';
import { notify } from './ui.js';
import { exportMarkdown } from './export.js';
import { t } from './i18n.js';

const root = document.documentElement;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function initFeed() {
  const thread = $('#thread');
  const list = $('#message-list');
  const wrap = thread?.parentElement;
  if (!thread || !list || !wrap) return;

  const button = (name, label, onClick, extra = '') => h('button', { type: 'button', className: `feed-btn ${extra}`.trim(), 'aria-label': label, title: label, onClick }, icon(name, 22));
  const up = button('chevron-down', t('feed.prevTurn'), () => go(-1), 'feed-up');
  const down = button('chevron-down', t('feed.nextTurn'), () => go(1));
  const copy = button('copy', t('feed.copyPage'), () => copyPage());
  const save = button('download', t('feed.export'), () => exportPage());
  const count = h('span', { className: 'feed-count', 'aria-live': 'polite' });
  const rail = h('div', { className: 'feed-rail', hidden: true, 'data-testid': 'feed-rail' }, up, count, down, copy, save);
  wrap.append(rail);

  const pages = () => [...list.querySelectorAll(':scope > .msg-user')];
  const topOf = (el) => el.getBoundingClientRect().top - thread.getBoundingClientRect().top + thread.scrollTop;

  // The page being read: the last one whose top is above 40% of the visible height (the newest when scrolled to the end).
  function current() {
    const all = pages();
    if (!all.length) return -1;
    if (thread.scrollHeight - thread.scrollTop - thread.clientHeight < 8) return all.length - 1;
    let index = 0;
    all.forEach((el, i) => { if (topOf(el) <= thread.scrollTop + thread.clientHeight * 0.4) index = i; });
    return index;
  }

  function go(step) {
    const all = pages();
    const target = all[Math.min(all.length - 1, Math.max(0, current() + step))];
    if (target) thread.scrollTo({ top: topOf(target), behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  function answerOf(index) {
    const all = pages();
    let el = all[index]?.nextElementSibling;
    while (el && !el.classList.contains('msg-user')) {
      if (el.classList.contains('msg-assistant')) return el;
      el = el.nextElementSibling;
    }
    return null;
  }

  function copyPage() {
    const btn = answerOf(current())?.querySelector('.meta button');
    if (!btn) return notify(t('feed.copyPage.empty'));
    btn.click();
    copy.replaceChildren(icon('check', 22));
    setTimeout(() => copy.replaceChildren(icon('copy', 22)), 1200);
  }

  function exportPage() {
    const session = state.session ?? state.sessions.find((s) => s.id === state.sessionId);
    if (session) exportMarkdown(session);
  }

  // A long first paragraph is set smaller than a one-line answer, so the "at a glance" part never takes the whole page.
  const LEDE = ':scope > .md:first-of-type > p:first-child, :scope > .stream-content > .md:first-child > p:first-child';
  function tag() {
    for (const article of list.querySelectorAll('.msg-assistant.is-streaming, .msg-assistant:not([data-lede])')) {
      const lede = article.querySelector(LEDE);
      if (!lede) continue;
      article.dataset.lede = lede.textContent.length > 150 ? 'long' : 'short';
    }
  }

  // The last page can be shorter than the screen (a run that ended in tool calls has hardly any reply). It then gets blank
  // room below it, so it can still stand at the top of the screen; none while a reply is being written.
  function room() {
    const last = pages().at(-1);
    const live = root.hasAttribute('data-feed-live') || Boolean(list.querySelector('.is-streaming'));
    const tail = parseFloat(list.style.getPropertyValue('--feed-tail')) || 0;
    let need = 0;
    if (last && !live) {
      const end = topOf(list) + list.offsetHeight - tail;
      need = Math.max(0, Math.round(thread.clientHeight - (end - topOf(last))));
    }
    if (Math.abs(need - tail) > 1) list.style.setProperty('--feed-tail', `${need}px`);
  }

  let frame = 0;
  function update() {
    frame = 0;
    thread.style.setProperty('--feed-h', `${thread.clientHeight}px`);
    tag();
    room();
    const all = pages();
    const index = current();
    rail.hidden = all.length === 0 || thread.clientHeight < 420;
    count.textContent = all.length ? `${index + 1}/${all.length}` : '';
    up.disabled = index <= 0;
    down.disabled = index < 0 || index >= all.length - 1;
    // Snapping while a reply streams would fight the view following it.
    root.toggleAttribute('data-feed-live', Boolean(list.querySelector('.is-streaming')));
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };

  // Each reply fades in the first time it is on screen.
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('feed-seen'); seen.unobserve(entry.target); }
  }, { root: thread, threshold: 0.15 });
  function mark() {
    for (const el of list.querySelectorAll('.msg-assistant:not(.feed-pre)')) {
      el.classList.add('feed-pre');
      seen.observe(el);
    }
    schedule();
  }

  // The question is clamped to two lines; tapping it shows all of it.
  list.addEventListener('click', (event) => {
    const user = event.target.closest('.msg-user');
    if (!user || event.target.closest('a, button, .att, .thumb')) return;
    if (getSelection()?.toString()) return;
    user.classList.toggle('is-open');
  });

  // Soft page snapping, done by hand. A page that fits the screen settles on whichever page start is nearer, like turning a page.
  // A page taller than the screen scrolls freely; it only settles when a page start is within reach (so a long answer can be read).
  const NEAR_PX = 56;
  let touching = false;
  function settle() {
    if (touching || root.hasAttribute('data-feed-live')) return;
    const selection = getSelection();
    if (selection && !selection.isCollapsed) return;
    const all = pages();
    if (all.length < 2) return;
    const top = thread.scrollTop;
    const height = thread.clientHeight;
    if (thread.scrollHeight - top - height < 8) return;
    const tops = all.map(topOf);
    let i = 0;
    tops.forEach((y, k) => { if (y <= top + 1) i = k; });
    const start = tops[i];
    const next = tops[i + 1] ?? Infinity;
    let target = null;
    if (next - start <= height * 1.12) target = top - start < next - top ? start : next;
    else if (top - start < NEAR_PX) target = start;
    else if (next - top < NEAR_PX) target = next;
    if (target != null && Number.isFinite(target) && Math.abs(target - top) > 1) thread.scrollTo({ top: target, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
  let settleTimer = 0;
  const later = () => { clearTimeout(settleTimer); settleTimer = setTimeout(settle, 170); };
  if ('onscrollend' in window) thread.addEventListener('scrollend', settle); else thread.addEventListener('scroll', later, { passive: true });
  thread.addEventListener('touchstart', () => { touching = true; }, { passive: true });
  thread.addEventListener('touchend', () => { touching = false; later(); }, { passive: true });
  thread.addEventListener('touchcancel', () => { touching = false; }, { passive: true });

  // A chat opens on the start of its last page (its question and the top of the reply), not on the very bottom, where the
  // top of that page would be cut off. A reply that is still being written keeps following the bottom.
  // The page above can still grow after the chat opened (tables and pictures settle), which pushes the last page down; so the
  // alignment is repeated while the layout settles, and stops at the first thing the reader does.
  let holding = false;
  let holdTimer = 0;
  function alignLast() {
    if (root.hasAttribute('data-feed-live') || list.querySelector('.is-streaming')) return;
    room();
    const last = pages().at(-1);
    if (!last) return;
    releaseFollow();
    thread.scrollTo({ top: topOf(last), behavior: 'auto' });
    schedule();
  }
  const letGo = () => { holding = false; clearTimeout(holdTimer); };
  on('thread:opened', () => {
    holding = true;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(letGo, 3000);
    requestAnimationFrame(alignLast);
  });
  new ResizeObserver(() => { if (holding) alignLast(); }).observe(list);
  for (const type of ['wheel', 'touchstart', 'mousedown']) thread.addEventListener(type, letGo, { passive: true });
  document.addEventListener('keydown', (event) => { if (!event.target.closest?.('textarea, input')) letGo(); });

  thread.addEventListener('scroll', schedule, { passive: true });
  new ResizeObserver(schedule).observe(thread);
  new MutationObserver(mark).observe(list, { childList: true, subtree: true });
  // A reply that never reaches the observer (hidden tab, odd layout) must not stay invisible.
  setInterval(() => { for (const el of list.querySelectorAll('.feed-pre:not(.feed-seen)')) el.classList.add('feed-seen'); }, 3000);
  mark();
}
