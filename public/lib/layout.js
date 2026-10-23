// Responsive shell: the sidebar becomes a left drawer under 900px; Escape and the scrim close drawers.
import { $ } from './dom.js';
import { emit, on } from './state.js';

const sidebar = $('#sidebar');
const opener = $('#open-sidebar');
const mobile = matchMedia('(max-width: 899px)');

const isOpen = () => document.body.classList.contains('sidebar-open');

function setOpen(next) {
  document.body.classList.toggle('sidebar-open', next);
  sidebar.inert = mobile.matches && !next;
  opener.setAttribute('aria-expanded', String(next));
  if (next) sidebar.querySelector('button, input')?.focus();
  else if (mobile.matches) opener.focus();
}

export function initLayout() {
  sidebar.inert = mobile.matches;
  // Phone drawer: the button at the top of the chat list closes it (hidden on a desktop, where the list is a panel).
  $('#sidebar-collapse').addEventListener('click', () => setOpen(false));
  opener.addEventListener('click', () => setOpen(!isOpen()));
  $('#scrim').addEventListener('click', () => {
    if (isOpen()) setOpen(false);
    emit('inspector:close');
  });
  mobile.addEventListener('change', () => {
    document.body.classList.remove('sidebar-open');
    sidebar.inert = mobile.matches;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (document.body.classList.contains('inspector-open')) emit('inspector:close');
    else if (isOpen() && mobile.matches) setOpen(false);
  });
  initSwipe();
  on('sidebar:open', () => mobile.matches && !isOpen() && setOpen(true));
  // Picking something in the drawer is the end of that interaction.
  for (const type of ['session:select', 'agent:select']) on(type, () => isOpen() && mobile.matches && setOpen(false));
}

// Phone gesture: a swipe to the right opens the chat list, a swipe to the left closes it. It can start anywhere (the
// phone's own back gesture owns the screen edge), except on things that scroll or react sideways themselves: tables, code,
// inputs, dialogs, side panels, and while text is selected.
const SWIPE_MIN_PX = 70;
const SWIPE_MAX_MS = 700;
const NO_SWIPE = 'textarea, input, pre, .table-wrap, .code-block, .openui-host, .md-media, .dlg, .artifact, .inspector, .lightbox, .pop, [data-no-swipe]';

function scrollsSideways(el) {
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 2 && /(auto|scroll)/.test(getComputedStyle(node).overflowX)) return true;
  }
  return false;
}

function initSwipe() {
  let start = null;
  document.addEventListener('touchstart', (event) => {
    start = null;
    if (!mobile.matches || event.touches.length !== 1) return;
    const target = event.target;
    if (target.closest?.(NO_SWIPE) || scrollsSideways(target)) return;
    const selection = getSelection();
    if (selection && !selection.isCollapsed) return;
    const t = event.touches[0];
    start = { x: t.clientX, y: t.clientY, at: performance.now() };
  }, { passive: true });
  document.addEventListener('touchend', (event) => {
    const from = start;
    start = null;
    if (!from || !mobile.matches || document.querySelector('.dlg')) return;
    const t = event.changedTouches[0];
    const dx = t.clientX - from.x;
    const dy = t.clientY - from.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dy) > Math.abs(dx) * 0.5 || performance.now() - from.at > SWIPE_MAX_MS) return;
    if (dx > 0 && !isOpen()) setOpen(true);
    else if (dx < 0 && isOpen()) setOpen(false);
  }, { passive: true });
}
