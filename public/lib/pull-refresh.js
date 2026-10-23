// Pull-to-refresh for touch screens: drag down from the top of the thread to reload the app.
import { $, h } from './dom.js';
import { icon } from './icons.js';
import { loadSessions } from './sessions.js';
import { emit } from './state.js';

const TRIGGER_PX = 72;
const MAX_PULL_PX = 110;
const RESISTANCE = 0.5;

// Dragging a selection handle or extending a selection at the top of the thread must not turn into a pull.
const hasSelection = () => { const selection = getSelection(); return Boolean(selection && !selection.isCollapsed); };

// The scroller that is being read: the Feed home has its own, the hidden thread would always read as "at the top".
const homeOpen = () => document.documentElement.dataset.feedView === 'home';

function attach(area, thread, reload) {
  const indicator = h('div', { className: 'ptr', 'aria-hidden': 'true' }, icon('refresh', 18));
  area.append(indicator);
  let startY = null;
  let pull = 0;
  let scroller = thread;
  let atHome = false;

  const paint = (distance, animate) => {
    indicator.style.transition = animate ? 'transform 0.2s, opacity 0.2s' : 'none';
    indicator.style.opacity = String(Math.min(1, distance / TRIGGER_PX));
    indicator.style.transform = `translate(-50%, ${distance - 40}px) rotate(${distance * 3}deg)`;
    indicator.classList.toggle('is-ready', distance >= TRIGGER_PX);
  };

  area.addEventListener('touchstart', (event) => {
    atHome = homeOpen();
    scroller = atHome ? $('.fh-scroll') ?? thread : thread;
    const blocked = event.target.closest('.dock, .model-pop, .menu, .lightbox, textarea, input, pre, table, .fh-viewer, .fh-stories');
    startY = !blocked && !hasSelection() && scroller.scrollTop <= 0 && event.touches.length === 1 ? event.touches[0].clientY : null;
    pull = 0;
  }, { passive: true });

  area.addEventListener('touchmove', (event) => {
    if (startY === null) return;
    if (hasSelection()) { startY = null; if (pull) paint(0, true); pull = 0; return; }
    const delta = (event.touches[0].clientY - startY) * RESISTANCE;
    if (delta <= 0 || scroller.scrollTop > 0) { if (pull) paint(0, true); pull = 0; if (delta <= 0) startY = null; return; }
    pull = Math.min(delta, MAX_PULL_PX);
    event.preventDefault();
    paint(pull, false);
  }, { passive: false });

  const release = () => {
    if (startY === null) return;
    startY = null;
    if (pull >= TRIGGER_PX) {
      indicator.classList.add('is-loading');
      paint(TRIGGER_PX, true);
      reload(atHome, () => { indicator.classList.remove('is-loading'); paint(0, true); });
    } else {
      paint(0, true);
    }
    pull = 0;
  };
  area.addEventListener('touchend', release);
  area.addEventListener('touchcancel', release);
}

export function initPullRefresh() {
  if (!matchMedia('(pointer: coarse)').matches) return;
  // Home feed: only the list is fetched again (the spinner runs until it is back); a chat reloads the app as before.
  const reload = (home, done) => {
    if (!home) { setTimeout(() => location.reload(), 150); return; }
    // The chat list and the Fresh timeline both look again (the timeline listens for "fresh:refresh").
    const job = { tasks: [loadSessions({ silent: true }), new Promise((r) => setTimeout(r, 600))] };
    emit('fresh:refresh', job);
    Promise.allSettled(job.tasks).then(done);
  };
  attach($('#main'), $('#thread'), reload);
}
