// Thread scrolling, AI-chat style: sending a message starts following the reply as it streams. The first scroll gesture of
// the user ends the following for good (even once the reply is done); it starts again only on the next send, when a chat
// is opened, or with "Jump to latest".
import { $ } from './dom.js';

const NEAR_BOTTOM_PX = 48;
const scroller = $('#thread');
const jump = $('#jump-to-latest');

export const threadScroller = scroller;

let follow = false;

const selecting = () => {
  const selection = getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.anchorNode && scroller.contains(selection.anchorNode));
};

const gapToBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;

export function initScroll() {
  const sync = () => { jump.hidden = gapToBottom() < NEAR_BOTTOM_PX; };
  const stop = () => { follow = false; sync(); };
  scroller.addEventListener('scroll', sync, { passive: true });
  scroller.addEventListener('wheel', (event) => { if (event.deltaY < 0 && scroller.scrollTop > 0) stop(); }, { passive: true });
  scroller.addEventListener('pointerdown', (event) => { if (event.target === scroller) stop(); }); // dragging the scrollbar
  let touchY = null;
  scroller.addEventListener('touchstart', (event) => { touchY = event.touches[0]?.clientY ?? null; }, { passive: true });
  scroller.addEventListener('touchmove', (event) => {
    const y = event.touches[0]?.clientY;
    if (touchY !== null && y !== undefined && y > touchY + 4 && scroller.scrollTop > 0) stop();
    touchY = y ?? null;
  }, { passive: true });
  document.addEventListener('keydown', (event) => {
    if (['PageUp', 'Home', 'ArrowUp'].includes(event.key) && !event.target.closest?.('textarea, input') && scroller.scrollTop > 0) stop();
  });
  document.addEventListener('selectionchange', () => { if (follow && selecting()) stop(); });
  // The reply grows without any scroll event: keep its end in view while following.
  const pin = () => { if (follow && !selecting()) scroller.scrollTop = scroller.scrollHeight; sync(); };
  new ResizeObserver(pin).observe($('#message-list'));
  // The on-screen keyboard shrinks the visual viewport: keep the end in view while following.
  window.visualViewport?.addEventListener('resize', () => { pin(); setTimeout(pin, 150); });
  jump.addEventListener('click', () => {
    scrollToEnd();
    if (!matchMedia('(pointer: coarse)').matches) $('#composer-input').focus(); // no keyboard pop-up on a phone
  });
}

// Puts the cursor in `el` without scrolling the page or the thread.
export function focusQuietly(el) {
  el.focus({ preventScroll: true });
}

export function scrollToEnd() {
  follow = true;
  scroller.scrollTop = scroller.scrollHeight;
  jump.hidden = true;
}

// For a view that puts the thread somewhere other than the bottom on purpose (the Feed opens a chat on its last page).
export function releaseFollow() {
  follow = false;
}
