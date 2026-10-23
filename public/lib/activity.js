// The collapsible "Activity" group of an assistant reply: thinking steps, notes and tool calls in order.
import { h } from './dom.js';
import { icon } from './icons.js';
import { fmtDuration } from './format.js';
import { t } from './i18n.js';

// Collapsed unless the user has opened one; whatever they last chose (open or collapsed) applies to every reply, live or reloaded.
const PREF_KEY = 'hermes-web.activity-open';
let preferOpen = false;
try { preferOpen = localStorage.getItem(PREF_KEY) === '1'; } catch { /* storage unavailable: stay collapsed */ }

function rememberOpen(value) {
  preferOpen = value;
  try { localStorage.setItem(PREF_KEY, value ? '1' : '0'); } catch { /* not persisted */ }
}

export function createActivity() {
  const count = h('span', { className: 'activity-count' });
  const total = h('span', { className: 'activity-total' });
  const list = h('div', { className: 'activity-list' });
  const node = h(
    'details',
    { className: 'activity', 'data-testid': 'activity', hidden: true },
    h('summary', {}, icon('chevron-down', 14), h('span', { className: 'activity-title' }, t('chat.activity.title')), count, total),
    list,
  );
  node.open = preferOpen;
  // A click on the summary is the user's own choice (code changing `open` does not count).
  node.querySelector('summary').addEventListener('click', () => rememberOpen(!node.open));
  let steps = 0;
  let tools = 0;

  const paint = () => {
    count.textContent = [`${steps} ${steps === 1 ? 'step' : 'steps'}`, tools ? `${tools} ${tools === 1 ? 'tool call' : 'tool calls'}` : null].filter(Boolean).join(' · ');
  };
  return {
    node,
    list,
    add(el, { tool = false } = {}) {
      list.append(el);
      steps += 1;
      if (tool) tools += 1;
      node.hidden = false;
      paint();
    },
    setTotal(seconds) { total.textContent = seconds == null ? '' : fmtDuration(seconds); },
    isEmpty: () => steps === 0,
  };
}
