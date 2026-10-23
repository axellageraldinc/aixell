// The phone's Back button (and the back swipe of an installed app) steps back through the screens you visited instead of
// closing the app. At the very first screen the first press only shows a hint; a second press within a moment leaves.
//
// How: every screen change writes a history entry (navigate), an open dialog / drawer / story / picture counts as a screen of
// its own so Back closes it first, and one extra entry at the bottom (the "guard") catches the press that would otherwise exit.
// Entries are only added after the first tap: browsers skip entries a page makes before any interaction.

import { t } from './i18n.js';

const EXIT_WINDOW_MS = 2500;
const phone = matchMedia('(max-width: 899px)');
const here = () => location.pathname + location.search + location.hash;

let touched = false;
let exitTimer = 0;
let lastUrl = '';
let overlayEntry = false;
let overlayUrl = '';
let quiet = false; // a Back of our own is under way (its popstate is not the user's)
const queued = []; // screen changes that came in meanwhile

const overlayOpen = () => Boolean(
  document.querySelector('.dlg, .lightbox, .fh-viewer')
  || document.body.classList.contains('inspector-open')
  || (phone.matches && document.body.classList.contains('sidebar-open')));

function begin() {
  if (touched) return;
  touched = true;
  try {
    if (history.state?.guard) history.pushState({ app: true }, '', here());
    else if (!history.state?.app) {
      history.replaceState({ guard: true }, '', here());
      history.pushState({ app: true }, '', here());
    }
  } catch { /* without history control Back simply behaves as before */ }
  lastUrl = here();
}

const isNew = (url) => !/#\/[^/]+\/.+$/.test(url);

// Called whenever the app shows another screen (a chat, the home feed, an empty chat). Opening a chat for the first time
// (the "new chat" address becoming the chat's own) and anything before the first touch replace the entry instead.
export function navigate(url) {
  if (quiet) { queued.push(url); return; }
  if (new URL(url, location.href).href === location.href) return;
  try {
    if (history.state?.guard) clearTimeout(exitTimer);
    const replace = !touched || (isNew(here()) && !isNew(url) && !history.state?.guard);
    // An entry that stood for an overlay becomes the screen itself ("Open chat" in the story viewer): it must not be taken away again.
    if (replace) history.replaceState(history.state?.overlay ? { app: true } : history.state, '', url);
    else history.pushState({ app: true }, '', url);
    lastUrl = url;
  } catch { /* the address just is not updated */ }
}

function closeOverlay() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

function watchOverlays() {
  const check = () => {
    const open = overlayOpen();
    if (open && !overlayEntry && touched) {
      overlayEntry = true;
      overlayUrl = here();
      try { history.pushState({ app: true, overlay: true }, '', here()); } catch { /* no history control */ }
    } else if (!open && overlayEntry) {
      overlayEntry = false;
      // Closed some other way (a button): its entry is still on top, so it is taken away again quietly. If the app already moved
      // on, the entry stays inside the history and Back steps over it later.
      try { if (history.state?.overlay && here() === overlayUrl) { quiet = true; history.back(); } } catch { quiet = false; }
    }
  };
  new MutationObserver(check).observe(document.body, { childList: true, attributes: true, attributeFilter: ['class'] });
}

// hint(): shows the "press once more to leave" message (passed in so this module imports nothing from the app).
export function initBackNav(hint) {
  // A touch only counts as a user action when the finger lifts (pointerup), which is also when browsers start accepting entries.
  const start = () => { document.removeEventListener('pointerup', start, true); document.removeEventListener('keydown', start, true); begin(); };
  document.addEventListener('pointerup', start, true);
  document.addEventListener('keydown', start, true);
  watchOverlays();

  window.addEventListener('popstate', (event) => {
    const state = event.state;
    if (quiet) { quiet = false; for (const url of queued.splice(0)) navigate(url); return; }
    // Back with something open closes that first.
    if (overlayOpen()) { overlayEntry = false; closeOverlay(); return; }
    // An entry that only stood for a closed dialog / drawer: step over it.
    if (state?.stale || state?.overlay) { history.back(); return; }
    // The bottom of the history: ask for a second press before the app closes.
    if (state?.guard) {
      hint(t('nav.exitHint'));
      clearTimeout(exitTimer);
      exitTimer = setTimeout(() => { if (history.state?.guard) history.pushState({ app: true }, '', lastUrl || here()); }, EXIT_WINDOW_MS);
      return;
    }
    lastUrl = here();
  });
}
