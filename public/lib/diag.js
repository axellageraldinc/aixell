// Layout diagnostics, off by default (Settings → App version). A small overlay with the numbers that say what moved
// when the bottom bar is cut off: layout vs visual viewport, where the app and the composer end, and the scroll offsets.
// "worst" remembers the largest overshoot of the composer past the bottom edge since the overlay was switched on.
const KEY = 'hermes-web:diag';
let box = null;
let worst = 0;
let last = '-';

export const diagOn = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

const bottomOf = (selector) => Math.round(document.querySelector(selector)?.getBoundingClientRect().bottom ?? NaN);

function paint() {
  if (!box) return;
  const vv = window.visualViewport;
  const composer = bottomOf('#composer');
  const over = composer - innerHeight;
  if (Number.isFinite(over) && over > worst) worst = over;
  box.textContent = [
    `inner ${innerWidth}x${innerHeight}  vv ${Math.round(vv?.width ?? 0)}x${Math.round(vv?.height ?? 0)} top ${Math.round(vv?.offsetTop ?? 0)} s${vv?.scale?.toFixed(2) ?? '?'}`,
    `app ${bottomOf('.app')}  main ${bottomOf('#main')}  dock ${bottomOf('.dock')}  composer ${composer}  appH ${getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim() || '-'}`,
    `over ${over}  worst ${worst}  screen ${screen.height}  dpr ${devicePixelRatio}`,
    `scrollY ${Math.round(scrollY)}  html ${document.documentElement.scrollTop}  body ${document.body.scrollTop}  thread ${Math.round(document.querySelector('#thread')?.scrollTop ?? 0)}`,
    `display ${matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser'}  last ${last}`,
    `bar ${document.querySelector('meta[name="theme-color"]')?.content ?? 'none'}  theme ${document.documentElement.getAttribute('data-theme') ?? 'system'}  system ${matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'}  bg ${getComputedStyle(document.body).backgroundColor}`,
  ].join('\n');
}

export function setDiag(on) {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* per-page only */ }
  if (on) start(); else stop();
}

function start() {
  if (box) return;
  worst = 0;
  box = document.createElement('pre');
  box.id = 'diag';
  box.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;margin:0;padding:4px 6px;font:10px/1.35 monospace;color:#7CFC00;background:rgba(0,0,0,.78);pointer-events:none;white-space:pre;max-width:100vw;overflow:hidden';
  document.body.append(box);
  paint();
}

function stop() { box?.remove(); box = null; }

export function initDiag() {
  const events = ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'scroll', 'resize'];
  for (const type of events) window.addEventListener(type, () => { last = type; paint(); }, { capture: true, passive: true });
  window.visualViewport?.addEventListener('resize', () => { last = 'vv-resize'; paint(); });
  window.visualViewport?.addEventListener('scroll', () => { last = 'vv-scroll'; paint(); });
  setInterval(paint, 500);
  if (diagOn()) start();
}
