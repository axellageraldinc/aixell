// Usage drawer (right). Opens from the cost chip, the context meter or the header button; closes with Escape,
// the scrim, a click outside or the x button. Model, effort and speed are chosen in the composer, not here.
import { $ } from './dom.js';
import { emit, on } from './state.js';

const drawer = $('#inspector');
let isOpen = false;
let opener = null;

function open() {
  if (isOpen) return;
  opener = document.activeElement;
  isOpen = true;
  drawer.inert = false;
  drawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('inspector-open');
  emit('inspector:shown');
  $('#inspector-close').focus();
}

function close() {
  if (!isOpen) return;
  isOpen = false;
  drawer.inert = true;
  drawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('inspector-open');
  emit('inspector:hidden');
  opener?.focus();
}

export function initInspector() {
  drawer.inert = true;
  $('#inspector-close').addEventListener('click', close);
  on('inspector:toggle', () => (isOpen ? close() : open()));
  on('inspector:close', close);
  // A click anywhere outside the drawer closes it; its own openers toggle it instead.
  document.addEventListener('pointerdown', (event) => {
    if (isOpen && !event.target.closest('#inspector, .cost-chip, .context-meter, .floating-menu')) close();
  });
}
