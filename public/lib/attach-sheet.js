// Phone attach menu: a bottom sheet with Camera / Photo / File and a shortcut to the prompt templates. On a desktop the
// attach button goes straight to the file picker instead (see composer.js).
import { h } from './dom.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

const CLOSE_DRAG_PX = 90;
let open = null;

export function openAttachSheet({ onFiles, onTemplate }) {
  if (open) return;
  const opener = document.activeElement;
  const picker = (attrs) => {
    const input = h('input', { type: 'file', hidden: true, ...attrs });
    input.addEventListener('change', () => {
      const files = [...input.files];
      input.value = '';
      close();
      if (files.length) onFiles(files);
    });
    return input;
  };
  const camera = picker({ accept: 'image/*', capture: 'environment', 'data-testid': 'sheet-input-camera' });
  const photos = picker({ accept: 'image/*,video/*', multiple: true, 'data-testid': 'sheet-input-photos' });
  const files = picker({ multiple: true, 'data-testid': 'sheet-input-files' });

  const tile = (name, label, input, testid) => h('button', { type: 'button', className: 'sheet-tile', 'data-testid': testid, onClick: () => input.click() }, icon(name, 26), h('span', {}, label));
  const close = () => {
    if (!open) return;
    const { root, sheet } = open;
    open = null;
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('sheet-open');
    sheet.classList.add('is-closing');
    sheet.style.transform = '';
    root.classList.add('is-closing');
    setTimeout(() => { root.remove(); opener?.focus?.(); }, 220);
  };
  const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };

  const closeBtn = h('button', { type: 'button', className: 'ibtn sheet-close', 'aria-label': t('common.close'), 'data-testid': 'sheet-close', onClick: close }, icon('x', 20));
  const grab = h('div', { className: 'sheet-grab', 'aria-hidden': 'true' });
  const head = h('div', { className: 'sheet-head' }, closeBtn, h('h2', {}, t('composer.attach.title')), h('span', { className: 'sheet-spacer' }));
  const template = h('button', { type: 'button', className: 'sheet-row', 'data-testid': 'sheet-template', onClick: () => { close(); onTemplate(); } },
    h('span', { className: 'sheet-row-icon' }, icon('zap', 20)),
    h('span', { className: 'sheet-row-text' }, h('span', { className: 'sheet-row-title' }, t('composer.attach.template')), h('span', { className: 'sheet-row-sub' }, t('composer.attach.templateHint'))),
    icon('chevron-right', 18));
  const sheet = h('div', { className: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('composer.attach.title'), 'data-testid': 'attach-sheet' },
    grab, head,
    h('div', { className: 'sheet-tiles' }, tile('camera', t('composer.attach.camera'), camera, 'sheet-camera'), tile('image', t('composer.attach.photo'), photos, 'sheet-photos'), tile('file', 'File', files, 'sheet-files')),
    template, camera, photos, files);
  const root = h('div', { className: 'sheet-root' }, h('div', { className: 'sheet-backdrop', onClick: close }), sheet);
  open = { root, sheet };
  document.body.classList.add('sheet-open');
  document.body.append(root);
  document.addEventListener('keydown', onKey, true);

  // Pull the sheet down by its handle or title to dismiss it.
  let startY = null;
  let dy = 0;
  for (const handle of [grab, head]) {
    handle.addEventListener('touchstart', (event) => { if (event.target.closest('button')) return; startY = event.touches[0].clientY; dy = 0; sheet.classList.add('is-dragging'); }, { passive: true });
  }
  sheet.addEventListener('touchmove', (event) => {
    if (startY === null) return;
    dy = Math.max(0, event.touches[0].clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  const release = () => {
    if (startY === null) return;
    startY = null;
    sheet.classList.remove('is-dragging');
    if (dy > CLOSE_DRAG_PX) close();
    else sheet.style.transform = '';
  };
  sheet.addEventListener('touchend', release, { passive: true });
  sheet.addEventListener('touchcancel', release, { passive: true });
  closeBtn.focus();
}
