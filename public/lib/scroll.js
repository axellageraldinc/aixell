// Thread scrolling, AI-chat style: the thread only moves when the user acts (opens a chat, sends a message, taps
// "Jump to latest"). A streaming reply grows below the viewport and never drags the view along.
import { $ } from './dom.js';

const NEAR_BOTTOM_PX = 48;
const scroller = $('#thread');
const jump = $('#jump-to-latest');

export const threadScroller = scroller;

const gapToBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;

export function initScroll() {
  const sync = () => { jump.hidden = gapToBottom() < NEAR_BOTTOM_PX; };
  scroller.addEventListener('scroll', sync, { passive: true });
  // Content growing below the viewport (a streaming reply) fires no scroll event: re-evaluate the button.
  new ResizeObserver(sync).observe($('#message-list'));
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
  scroller.scrollTop = scroller.scrollHeight;
  jump.hidden = true;
}
