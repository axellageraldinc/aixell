// Reading preferences kept in this browser: text size of the conversation and focus mode (only the conversation and the
// composer stay on screen). theme.js applies both before first paint; this changes them later.
import { t } from './i18n.js';
const SIZE_KEY = 'hermes.fontsize';
const FOCUS_KEY = 'hermes.focus';
export const SIZES = [['s', t('settings.display.textSize.small')], ['m', t('settings.display.textSize.normal')], ['l', t('settings.display.textSize.large')], ['xl', 'XL']];
const root = document.documentElement;

const save = (key, value) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice applies to this page only.
  }
};

export const currentSize = () => root.getAttribute('data-fs') || 'm';
export const isFocus = () => root.hasAttribute('data-focus');

export function setSize(size) {
  if (!SIZES.some(([value]) => value === size)) return;
  if (size === 'm') root.removeAttribute('data-fs');
  else root.setAttribute('data-fs', size);
  save(SIZE_KEY, size === 'm' ? null : size);
}

export function setFocus(on) {
  root.toggleAttribute('data-focus', on);
  save(FOCUS_KEY, on ? '1' : null);
  window.dispatchEvent(new Event('hermes:focus'));
}

export function initDisplay() {
  const exit = document.createElement('button');
  exit.type = 'button';
  exit.className = 'focus-exit btn btn-sm';
  exit.textContent = t('settings.display.focus.exit');
  exit.addEventListener('click', () => setFocus(false));
  document.body.append(exit);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      setFocus(!isFocus());
    } else if (event.key === 'Escape' && isFocus() && !document.querySelector('.dlg, .pop:not([hidden])')) {
      setFocus(false);
    }
  });
}
