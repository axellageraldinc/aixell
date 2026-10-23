// Colour mode preference (light | dark | auto). theme.js applies it before first paint; this changes it later.
// The stored colour mode names are not UI text, so they stay as they are.
const KEY = 'hermes.theme';
const MODES = ['light', 'dark', 'auto'];

export function currentTheme() {
  const mode = document.documentElement.getAttribute('data-color-mode');
  return MODES.includes(mode) ? mode : 'light';
}

const COLORS = { light: '#fbfcfe', dark: '#16191f' };
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

// The status bar of a phone (and the browser toolbar) takes its colour from this tag, so it has to follow the app's theme.
function paintBar() {
  const mode = currentTheme();
  const dark = mode === 'dark' || (mode === 'auto' && systemDark.matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? COLORS.dark : COLORS.light);
}
systemDark.addEventListener('change', paintBar);

export function setTheme(mode) {
  if (!MODES.includes(mode)) return;
  const root = document.documentElement;
  root.setAttribute('data-color-mode', mode);
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode === 'dark' ? 'aixell-dark' : 'aixell');
  paintBar();
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Storage unavailable: the choice applies to this page only.
  }
}
