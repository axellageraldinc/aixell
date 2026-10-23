// Full-size image viewer. Closes on Esc, a click on the backdrop or the close button.
import { h } from './dom.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

export function openLightbox(src, name) {
  const opener = document.activeElement;
  const close = h('button', { type: 'button', className: 'ibtn lightbox-close', 'aria-label': t('lightbox.close') }, icon('x', 18));
  const overlay = h(
    'div',
    { className: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': name || t('lightbox.label'), 'data-testid': 'lightbox' },
    close,
    h('figure', {}, h('img', { src, alt: name || '' }), name ? h('figcaption', {}, name) : null),
  );
  const shut = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    opener?.focus?.();
  };
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    shut();
  };
  overlay.addEventListener('click', (event) => { if (event.target === overlay || event.target.closest('.lightbox-close')) shut(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  close.focus();
}
