// One shared floating action menu (row actions, account menu). It lives outside any scrolling
// container and is positioned with fixed coordinates, so lists never clip it.
// items: [{ label, icon, testid, destructive, checked, action, confirm: { prompt, label } }],
// plus { heading } rows, { separator: true } rows and { node } rows (static content such as the usage card).
import { h } from './dom.js';
import { icon } from './icons.js';
import { bindListNav } from './popover.js';
import { t } from './i18n.js';

let panel = null;
let menu = null;
let anchor = null;

function ensure() {
  if (panel) return;
  menu = h('div', { role: 'menu' });
  panel = h('div', { className: 'pop floating-menu', hidden: true }, menu);
  document.body.append(panel);
  bindListNav(menu, '[role^=menuitem]');
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') closeMenu(false);
  });
}

function entry(item) {
  if (item.node) return item.node;
  if (item.separator) return h('hr', { className: 'menu-sep' });
  if (item.heading) return h('div', { className: 'menu-heading', role: 'presentation' }, item.heading);
  const radio = item.checked !== undefined;
  return h(
    'button',
    {
      type: 'button',
      role: radio ? 'menuitemradio' : 'menuitem',
      'aria-checked': radio ? String(item.checked) : null,
      className: item.destructive ? 'menu-item is-danger' : 'menu-item',
      tabindex: -1,
      'data-testid': item.testid,
      onClick: () => activate(item),
    },
    item.icon ? icon(item.icon) : null,
    h('span', { className: 'menu-label' }, item.label),
    item.checked ? icon('check') : null,
  );
}

function render(rows, prompt) {
  menu.replaceChildren(...(prompt ? [h('div', { className: 'menu-heading', role: 'presentation' }, prompt)] : []), ...rows.map(entry));
  menu.querySelector('[role^=menuitem]')?.focus();
}

// A destructive item swaps the menu for an inline Confirm / Cancel pair instead of a dialog.
function activate(item) {
  if (item.confirm) {
    render(
      [
        { label: item.confirm.label, destructive: true, action: item.action },
        { label: t('common.cancel'), action: null },
      ],
      item.confirm.prompt,
    );
    return;
  }
  closeMenu(false);
  item.action?.();
}

function place() {
  const rect = anchor.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = panel;
  // A trigger on the left side of the screen (data-menu-align="left") opens its menu flush with its own left edge.
  const flush = anchor.dataset.menuAlign === 'left' ? rect.left : rect.right - width;
  const left = Math.max(8, Math.min(flush, window.innerWidth - width - 8));
  const below = rect.bottom + 4;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below;
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

const onPointerDown = (event) => {
  if (!panel.contains(event.target) && !anchor.contains(event.target)) closeMenu(false);
};
const onKeyDown = (event) => {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  closeMenu(true);
};
const onDismiss = () => closeMenu(false);

export function openMenu(trigger, items, label = t('menu.actions')) {
  ensure();
  const sameTrigger = anchor === trigger;
  closeMenu(false);
  if (sameTrigger) return;
  anchor = trigger;
  anchor.setAttribute('aria-expanded', 'true');
  menu.setAttribute('aria-label', label);
  panel.hidden = false;
  render(items);
  place();
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', onDismiss);
  document.addEventListener('scroll', onDismiss, true);
}

export function closeMenu(restoreFocus = false) {
  if (!panel || !anchor) return;
  panel.hidden = true;
  anchor.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('resize', onDismiss);
  document.removeEventListener('scroll', onDismiss, true);
  if (restoreFocus) anchor.focus();
  anchor = null;
}
