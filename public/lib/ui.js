// Shared small UI pieces: status blocks, skeleton rows and the transient toast.
import { h, $ } from './dom.js';
import { t } from './i18n.js';

// kind: 'loading' | 'empty' | 'error'. Errors get an optional Retry button.
export function statusBlock({ kind, text, onRetry }) {
  return h(
    'div',
    { className: `status status-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('p', {}, text),
    onRetry
      ? h('button', { type: 'button', className: 'btn btn-sm btn-ghost', onClick: onRetry }, t('common.retry'))
      : null,
  );
}

// Flat grey bars while a list loads.
export function skeletonRows(count, className = 'skeleton-row') {
  return Array.from({ length: count }, () => h('div', { className: `skeleton ${className}`, 'aria-hidden': 'true' }));
}

const toaster = $('#toaster');
let toastTimer = 0;

export function notify(message) {
  clearTimeout(toastTimer);
  toaster.replaceChildren(
    h('div', { className: 'alert toast-msg', role: 'status', 'aria-atomic': 'true' }, message),
  );
  toastTimer = setTimeout(() => toaster.replaceChildren(), 4000);
}
