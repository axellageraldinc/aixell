// Thread scrolling: stick to the bottom while streaming unless the user scrolled up, then offer "Jump to latest".
import { $ } from './dom.js';

const FOLLOW_GAP_PX = 48;
const scroller = $('#thread');
const jump = $('#jump-to-latest');
let follow = true;
let quiet = false; // a focus the app gives back itself (not a tap on the box): it must not move the thread

export const threadScroller = scroller;

const MESSAGE_LIST = $('#message-list');

// Text is selected inside the thread: nothing may move the content under the user's fingers.
const selecting = () => {
  const selection = getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.anchorNode && scroller.contains(selection.anchorNode));
};

export function initScroll() {
  // Any upward gesture stops the auto-follow at once; it resumes only when the user is back at the bottom.
  const stopFollowing = () => { follow = false; jump.hidden = false; };
  scroller.addEventListener('wheel', (event) => { if (event.deltaY < 0 && scroller.scrollTop > 0) stopFollowing(); }, { passive: true });
  let touchY = null;
  scroller.addEventListener('touchstart', (event) => { touchY = event.touches[0]?.clientY ?? null; }, { passive: true });
  scroller.addEventListener('touchmove', (event) => {
    const y = event.touches[0]?.clientY;
    if (touchY !== null && y !== undefined && y > touchY + 4 && scroller.scrollTop > 0) stopFollowing();
    touchY = y ?? null;
  }, { passive: true });
  document.addEventListener('keydown', (event) => {
    if (['PageUp', 'Home', 'ArrowUp'].includes(event.key) && !event.target.closest?.('textarea, input') && scroller.scrollTop > 0) stopFollowing();
  });
  // Content grows without any scroll event (thinking steps, the wait counter, tool output): keep the bottom in view while following.
  new ResizeObserver(() => { if (follow && !selecting()) scroller.scrollTop = scroller.scrollHeight; }).observe(MESSAGE_LIST);
  // The on-screen keyboard shrinks the visual viewport, not the layout: the thread gets shorter and the last line ends up
  // under the keyboard. Re-pin to the bottom whenever the viewport changes while following. The shell height is applied by
  // lib/viewport.js from the same event, so the re-pin runs once after the next layout too — a single frame can fire
  // before `--app-h` has shrunk the thread.
  const repin = () => { if (follow && !selecting()) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; }); };
  const repinSoon = () => { repin(); setTimeout(repin, 120); setTimeout(repin, 320); };
  window.visualViewport?.addEventListener('resize', repinSoon);
  window.visualViewport?.addEventListener('scroll', repin);
  // Focusing the box (the tap that opens the keyboard) from the bottom of the chat means "I am writing here"; from anywhere
  // else it must not move what is being read.
  document.addEventListener('focusin', (event) => {
    if (quiet || !event.target.closest?.('#composer')) return;
    // Already at the bottom: keep following while typing. Reading higher up: leave the thread exactly where it is.
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > FOLLOW_GAP_PX) return;
    follow = true;
    repin();
  });
  // Selecting text while a reply streams means reading it: stop following until the selection is gone.
  document.addEventListener('selectionchange', () => { if (follow && selecting()) { follow = false; jump.hidden = false; } });
  scroller.addEventListener('scroll', () => {
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    // Resume only at the very bottom, so a small upward scroll is not undone by the next token.
    if (gap > FOLLOW_GAP_PX) follow = false;
    else if (gap < 4) follow = true;
    jump.hidden = follow || gap < 4;
  });
  jump.addEventListener('click', () => {
    scrollToEnd(true);
    if (!matchMedia('(pointer: coarse)').matches) $('#composer-input').focus(); // no keyboard pop-up on a phone
  });
}

// Puts the cursor in `el` without scrolling the page or the thread, and without counting as "the user went back to the bottom".
export function focusQuietly(el) {
  quiet = true;
  try { el.focus({ preventScroll: true }); } finally { quiet = false; }
}

// For a view that puts the thread somewhere other than the bottom on purpose (the Feed opens a chat on its last page): stop
// pinning to the bottom, or the next layout change would drag it back.
export function releaseFollow() {
  follow = false;
  jump.hidden = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4;
}

export function scrollToEnd(force = false) {
  if (force) follow = true;
  if (!follow || (!force && selecting())) return;
  scroller.scrollTop = scroller.scrollHeight;
  jump.hidden = true;
}
