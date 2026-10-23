// Segmented single-choice control built from daisyUI buttons. `group` joins them into one `join`;
// otherwise they wrap as separate small buttons. The selected one carries .selected.
import { h } from './dom.js';

// options: [{ value, label, testid? }]
export function segmented({ label, options, onSelect, group = false }) {
  const buttons = new Map();
  const el = h(
    'div',
    { className: group ? 'seg join w-full' : 'seg', role: 'radiogroup', 'aria-label': label },
    options.map((option) => {
      const button = h(
        'button',
        {
          type: 'button',
          role: 'radio',
          className: group ? 'btn btn-sm join-item flex-1' : 'btn btn-sm',
          'data-testid': option.testid,
          onClick: () => onSelect(option.value),
        },
        option.label,
      );
      buttons.set(option.value, button);
      return button;
    }),
  );
  return {
    el,
    set(value, disabled = false) {
      for (const [optionValue, button] of buttons) {
        const checked = optionValue === value;
        button.setAttribute('aria-checked', String(checked));
        button.classList.toggle('selected', checked);
        button.classList.toggle('btn-active', checked);
        button.disabled = disabled;
      }
    },
  };
}
