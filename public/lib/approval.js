// Inline approval request: details, "Allow once" / "Deny" and a 120-second auto-deny countdown.
import { h } from './dom.js';
import { fieldLines } from './tools.js';
import { t } from './i18n.js';

const TIMEOUT_SECONDS = 120;

// onDecide(decision) must return a Promise; on failure the buttons come back.
export function approvalBlock(data, onDecide) {
  let remaining = TIMEOUT_SECONDS;
  let busy = false;
  const countdown = h('span', {}, t('approval.countdown', { remaining }));
  const allow = h('button', { type: 'button', className: 'btn btn-primary btn-sm', onClick: () => decide('once') }, t('approval.allowOnce'));
  const deny = h('button', { type: 'button', className: 'btn btn-sm', onClick: () => decide('deny') }, t('approval.deny'));
  const actions = h('div', { className: 'approval-actions' }, allow, deny, countdown);
  const result = h('p', { className: 'approval-result', role: 'status' });
  const node = h(
    'section',
    { className: 'approval', 'data-testid': 'approval-block', 'aria-label': t('approval.dialog.label') },
    h('h4', {}, t('approval.title')),
    h('pre', {}, fieldLines(data) || t('approval.noDetails')),
    actions,
    result,
  );

  const timer = setInterval(() => {
    remaining -= 1;
    countdown.textContent = t('approval.countdown', { remaining });
    if (remaining <= 0) decide('deny', t('approval.timeout'));
  }, 1000);

  async function decide(decision, message) {
    if (busy) return;
    busy = true;
    clearInterval(timer);
    allow.disabled = true;
    deny.disabled = true;
    try {
      await onDecide(decision);
      actions.hidden = true;
      result.textContent = message ?? (decision === 'once' ? t('approval.allowed') : t('approval.denied'));
    } catch (err) {
      busy = false;
      allow.disabled = false;
      deny.disabled = false;
      result.textContent = t('approval.sendFailed', { message: err.message });
    }
  }

  return node;
}
