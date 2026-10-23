// Model trigger inside the composer: shows the model (and effort) and opens the model popover.
import { $ } from './dom.js';
import { state, on } from './state.js';
import { bindPopover } from './popover.js';
import { skeletonRows } from './ui.js';
import { currentSettings, effectiveModelId, loadModels } from './models.js';

const PANEL_WIDTH = 380;
const textEl = $('#model-chip-text');
const panel = $('#model-popover');
let picker = null;
let opening = 0; // the picker's code is fetched on first open: a close in the meantime cancels the mount

// The label of the empty chat is remembered, so the next start shows it at once instead of "Model" until the catalogue is back.
const LABEL_KEY = 'hermes.modelLabel';
const remembered = () => { try { return localStorage.getItem(LABEL_KEY); } catch { return null; } };

function refresh() {
  const model = effectiveModelId();
  const { reasoningEffort: effort, serviceTier } = currentSettings();
  const label = model ? [model, effort ? effort : null, serviceTier === 'priority' ? 'priority' : null].filter(Boolean).join(' · ') : null;
  if (label && !state.sessionId) { try { localStorage.setItem(LABEL_KEY, label); } catch { /* shown again next time */ } }
  textEl.textContent = label ?? (state.sessionId ? null : remembered()) ?? 'Model';
}

// Fixed coordinates: opens upward unless there is clearly more room below, and clears the whole composer.
function placePanel() {
  const chip = $('#model-chip').getBoundingClientRect();
  const composer = $('#composer').getBoundingClientRect();
  const above = composer.top - 8;
  const below = window.innerHeight - composer.bottom - 8;
  const up = above >= below || above >= 480;
  const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
  panel.style.width = `${width}px`;
  panel.style.left = `${Math.max(8, Math.min(chip.left, window.innerWidth - width - 8))}px`;
  panel.style.bottom = up ? `${window.innerHeight - composer.top + 8}px` : '';
  panel.style.top = up ? '' : `${composer.bottom + 8}px`;
  panel.style.maxHeight = `${Math.max(240, Math.min(up ? above - 8 : below - 8, 640))}px`;
}

// The picker only exists while the popover is open, so its test hooks are never duplicated.
export function initModelChip() {
  bindPopover($('#model-chip-root'), {
    onOpen() {
      placePanel();
      loadModels({ silent: true });
      const mine = ++opening;
      panel.replaceChildren(...skeletonRows(4, 'skeleton-option'));
      import('./model-picker.js').then(({ mountPicker }) => {
        if (mine !== opening) return;
        picker = mountPicker(panel);
        picker.focusSearch();
      });
    },
    onClose() {
      opening += 1;
      picker?.destroy();
      picker = null;
    },
  });
  for (const type of ['models:changed', 'settings:changed', 'session:changed', 'agent:select']) on(type, refresh);
  refresh();
}

