// Runs a callback once a node that was just built has had a chance to reach the document. React renders into a node
// that must already be connected, so visual blocks mount after the thread is painted rather than while it is being
// assembled.
//
// requestAnimationFrame is the right primitive while the page is visible, but a hidden tab (phone asleep, another
// tab in front) never fires it — a reply that finishes in the background would then leave an empty block on screen
// until the next repaint. A timer covers that case; it is throttled in a hidden tab but still runs.
export function afterPaint(fn) {
  if (typeof requestAnimationFrame === 'function' && !document.hidden) {
    return requestAnimationFrame(() => requestAnimationFrame(fn));
  }
  return setTimeout(fn, 0);
}
