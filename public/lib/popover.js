// Open/close behaviour for an anchored panel (<div class="pop" hidden>) next to its trigger button:
// aria state, outside click, Escape (handled first so it never also closes a drawer) and focus return.

export function bindPopover(root, { onOpen, onClose } = {}) {
  const trigger = root.querySelector(':scope > button');
  const panel = root.querySelector(':scope > .pop');
  let open = false;

  const onPointerDown = (event) => {
    if (!root.contains(event.target)) close(false);
  };
  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close(true);
  };

  function show() {
    if (open) return;
    open = true;
    trigger.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    onOpen?.();
  }

  function close(restoreFocus = true) {
    if (!open) return;
    open = false;
    trigger.setAttribute('aria-expanded', 'false');
    panel.hidden = true;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    onClose?.();
    if (restoreFocus) trigger.focus();
  }

  trigger.addEventListener('click', () => (open ? close(true) : show()));
  return { trigger, panel, show, close, isOpen: () => open };
}

// Arrow/Home/End focus movement between the items of a menu or listbox.
export function bindListNav(container, selector) {
  container.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...container.querySelectorAll(selector)].filter((el) => !el.hidden && !el.disabled);
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    let next;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'ArrowDown') next = index + 1 >= items.length ? 0 : index + 1;
    else next = index <= 0 ? items.length - 1 : index - 1;
    items[next].focus();
  });
}
