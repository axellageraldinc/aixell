// The shell is exactly one viewport tall. On Android Chrome a reload (its own pull-to-refresh, or the app's) can leave
// `100dvh` stale: the shell keeps the height it had while the URL bar was hidden even though the bar is back on screen,
// so the app ends up one toolbar taller than the screen and the composer is pushed under the bottom edge. The visual
// viewport reports the real height even then, so measure it here and hand it to CSS as `--app-h`; `100dvh` stays as the
// first-paint value and as the fallback where `visualViewport` is missing.
const root = document.documentElement;
let frame = 0;
let applied = 0;

function measure() {
  frame = 0;
  const vv = window.visualViewport;
  // A pinch-zoomed page reports a smaller visual viewport; the shell must keep its unzoomed height.
  if (vv && vv.scale > 1.01) return;
  const height = Math.round(vv?.height || window.innerHeight);
  // Ignore the transient sizes a rotation or a keyboard animation can report.
  if (height < 200 || height === applied) return;
  applied = height;
  root.style.setProperty('--app-h', `${height}px`);
}

function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(measure);
}

export function initViewport() {
  measure();
  addEventListener('resize', schedule);
  addEventListener('orientationchange', schedule);
  addEventListener('pageshow', schedule);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  // The URL bar animates back in after a reload: a couple of late measures catch a height read mid-animation.
  setTimeout(schedule, 250);
  setTimeout(schedule, 900);
}
