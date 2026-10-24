// Model picker: search, model list, effort, speed and reset. Mounted in the composer popover and in
// the Inspector's Model tab; each mount subscribes to state changes and detaches on destroy.
import { h } from './dom.js';
import { icon } from './icons.js';
import { state, on } from './state.js';
import { fmtCompact, fmtMoney } from './format.js';
import { statusBlock, skeletonRows } from './ui.js';
import { segmented } from './segmented.js';
import { bindListNav } from './popover.js';
import { api, agentPath } from './api.js';
import { notify } from './ui.js';
import { loadModels, modelsStatus, findModel, currentSettings, effectiveModelId, updateSettings, resetSettings, visualizeOn, setVisualize } from './models.js';
import { t } from './i18n.js';

const usd = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const money = (n, currency) => (!currency || currency === 'USD' ? usd(n) : fmtMoney(n, currency));
const tierLabel = (tier) => (tier === 'default' ? t('model.tier.default') : tier.charAt(0).toUpperCase() + tier.slice(1));

// Only known parts are printed; unknown values are never guessed.
function metaLine(m) {
  const { contextWindow, price: p, quota } = m;
  const prices = [p?.inputPerM != null ? `${money(p.inputPerM, p.currency)} in` : null, p?.outputPerM != null ? `${money(p.outputPerM, p.currency)} out` : null].filter(Boolean);
  const parts = [
    contextWindow != null ? `ctx ${fmtCompact(contextWindow)}` : null,
    prices.length ? prices.join(' / ') : null,
    quota?.requestsPerMonth != null ? `${fmtCompact(quota.requestsPerMonth)} req/mo` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : t('model.price.none');
}

// Switching to a model without reasoning drops the effort override.
function select(m) {
  const patch = { model: m.id, provider: m.provider };
  if (!m.reasoning) patch.reasoningEffort = undefined;
  updateSettings(patch);
}

// Non-text modalities a model takes in or produces: [{ label, direction: 'in' | 'out' | 'in/out' }].
// null = the catalogue does not say (never guessed). An empty list = text only.
const MODALITY_LABEL = { image: t('model.modality.image'), audio: t('model.modality.audio'), video: t('model.modality.video'), pdf: t('model.modality.pdf') };
export function modalityTags(m) {
  if (!m.modalities) return null;
  const { input, output } = m.modalities;
  return Object.keys(MODALITY_LABEL)
    .filter((key) => input.includes(key) || output.includes(key))
    .map((key) => ({ label: MODALITY_LABEL[key], direction: input.includes(key) && output.includes(key) ? 'in/out' : input.includes(key) ? 'in' : 'out' }));
}

const DIRECTION_HINT = { in: t('model.modality.directionIn'), out: t('model.modality.directionOut'), 'in/out': t('model.modality.directionInOut') };

function modalityLine(m) {
  const tags = modalityTags(m);
  if (tags === null) return h('span', { className: 'mo-mod' }, h('span', { className: 'badge badge-sm badge-ghost mod is-unknown', title: t('model.modality.unknownHint') }, t('model.modality.unknown')));
  if (tags.length === 0) return h('span', { className: 'mo-mod' }, h('span', { className: 'badge badge-sm badge-ghost mod', title: t('model.modality.textText') }, t('model.modality.textOnly')));
  return h(
    'span',
    { className: 'mo-mod' },
    tags.map((tag) => h('span', { className: `mod is-${tag.direction.replace('/', '-')}`, title: `${tag.label}: ${DIRECTION_HINT[tag.direction]}` }, `${tag.label} `, h('b', {}, tag.direction))),
  );
}

// A row is a wrapper: the option button plus the hide / unhide button (a button cannot sit inside a button).
function optionRow(m, onToggleHidden) {
  const option = h(
    'button',
    {
      type: 'button',
      role: 'option',
      className: 'model-option',
      tabindex: -1,
      'data-testid': 'model-option',
      'data-model': m.id,
      onClick: () => select(m),
    },
    h(
      'span',
      { className: 'mo-top' },
      h('span', { className: 'mo-name' }, m.id),
      m.reasoning ? h('span', { className: 'badge badge-sm badge-soft badge-primary tag', title: t('model.reasoning.hint') }, t('model.reasoning.label')) : null,
      h('span', { className: 'mo-check' }, icon('check')),
    ),
    h('span', { className: 'mo-meta' }, metaLine(m)),
    modalityLine(m),
  );
  const toggle = h(
    'button',
    {
      type: 'button',
      className: 'ibtn ibtn-sm mo-hide',
      tabindex: -1,
      'data-testid': m.hidden ? 'model-unhide' : 'model-hide',
      'aria-label': m.hidden ? t('model.pick.add', { model: m.id }) : t('model.pick.remove', { model: m.id }),
      title: m.hidden ? t('model.pick.addShort') : t('model.pick.removeHint'),
      onClick: (event) => { event.stopPropagation(); onToggleHidden(m); },
    },
    icon(m.hidden ? 'eye' : 'eye-off', 14),
  );
  return h('div', { className: m.hidden ? 'model-row is-hidden-model' : 'model-row', 'data-model': m.id }, option, toggle);
}

export function mountPicker(container) {
  const unsubscribe = [on('models:changed', build), on('settings:changed', sync), on('session:changed', sync)];
  let rows = [];
  let showHidden = false;
  let effort = null;
  let tier = null;
  let visualize = null;
  let reset = null;

  function build() {
    rows = [];
    const { status, errorMessage } = modelsStatus();
    if (status === 'loading') return container.replaceChildren(...skeletonRows(4, 'skeleton-option'));
    if (status === 'error') return container.replaceChildren(statusBlock({ kind: 'error', text: errorMessage, onRetry: loadModels }));

    const { models = [], effortLevels = [], serviceTiers = [] } = state.models;
    // A routed agent (one whose provider resolves the real model per request, e.g. xellter) has no model to pick:
    // the list is the provider's own catalogue, not something the app may choose from. Show the routing note only.
    const routed = state.models?.routed === true;
    if (routed) {
      effort = null; tier = null;
      visualize = switchControl({
        label: t('model.visuals.title'),
        hint: t('model.visuals.hint'),
        onChange: (on) => setVisualize(on),
      });
      reset = h('button', { type: 'button', className: 'btn btn-sm btn-ghost', onClick: resetSettings }, t('model.reset'));
      container.replaceChildren(
        h('p', { className: 'model-note', 'data-testid': 'model-routed' }, t('model.routed.note')),
        h('div', { className: 'picker-opts' }, visualize.el, reset),
      );
      sync();
      return;
    }
    const search = h('input', {
      type: 'search',
      className: 'input input-sm w-full',
      placeholder: t('model.search.placeholder'),
      'aria-label': t('model.search.label'),
      onInput: () => filter(search.value),
    });
    const list = h('div', { className: 'model-list', role: 'listbox', 'aria-label': t('model.list.label') });
    rows = models.map((m) => optionRow(m, toggleHidden));
    const hiddenCount = models.filter((m) => m.hidden).length;
    const hiddenToggle = hiddenCount
      ? h('button', { type: 'button', className: 'btn btn-sm btn-ghost hidden-toggle', 'data-testid': 'hidden-models-toggle', onClick: () => { showHidden = !showHidden; filter(search.value); hiddenToggle.textContent = hiddenLabel(hiddenCount); } }, hiddenLabel(hiddenCount))
      : null;
    list.append(...rows, ...(hiddenToggle ? [hiddenToggle] : []));
    if (rows.length === 0) list.append(statusBlock({ kind: 'empty', text: t('model.empty') }));
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') rows.find((row) => !row.hidden)?.firstElementChild.click();
    });

    const notes = [...new Set([state.models.note, ...models.map((m) => m.note)].filter((n) => typeof n === 'string' && n))];
    effort = segmented({
      label: t('model.effort.title'),
      options: [{ value: '', label: t('model.effort.default') }, ...effortLevels].map((o) =>
        typeof o === 'string' ? { value: o, label: o, testid: 'effort-option' } : { ...o, testid: 'effort-option' },
      ),
      onSelect: (value) => updateSettings({ reasoningEffort: value || undefined }),
    });
    tier = segmented({
      label: t('model.speed.title'),
      options: serviceTiers.map((value) => ({ value, label: tierLabel(value), testid: 'speed-option' })),
      onSelect: (value) => updateSettings({ serviceTier: value }),
    });
    visualize = switchControl({
      label: t('model.visuals.title'),
      hint: t('model.visuals.hint'),
      onChange: (on) => setVisualize(on),
    });
    reset = h('button', { type: 'button', className: 'btn btn-sm btn-ghost', onClick: resetSettings }, t('model.reset'));

    const picker = h('div', { className: 'model-select' }, search, list);
    bindListNav(picker, '.model-option');
    container.replaceChildren(
      picker,
      ...notes.map((text) => h('p', { className: 'model-note' }, text)),
      h('div', { className: 'picker-opts' }, field(t('model.effort.title'), effort.el), field(t('model.speed.title'), tier.el, t('model.speed.hint')), visualize.el, reset),
    );
    filter(search.value);
    sync();
  }

  const hiddenLabel = (n) => (showHidden ? t('model.hidden.showMine') : t('model.hidden.showMore', { n }));

  // Models switched off in the provider console still come back from its API; this keeps them out of the list.
  async function toggleHidden(m) {
    try {
      await api(`${agentPath(state.agent)}/models/${encodeURIComponent(m.id)}/hidden`, { method: 'PUT', body: { hidden: !m.hidden } });
      m.hidden = !m.hidden;
      build();
    } catch (err) {
      notify(err.message);
    }
  }

  function filter(query) {
    const needle = query.trim().toLowerCase();
    for (const row of rows) {
      const hiddenModel = row.classList.contains('is-hidden-model');
      row.hidden = (needle !== '' && !row.dataset.model.toLowerCase().includes(needle)) || (hiddenModel && !showHidden);
    }
  }

  function sync() {
    if (!state.models) return;
    const s = currentSettings();
    const selected = effectiveModelId();
    for (const row of rows) row.firstElementChild.setAttribute('aria-selected', String(row.dataset.model === selected));
    effort?.set(s.reasoningEffort ?? state.models.defaultEffort ?? '', !findModel(selected)?.reasoning);
    tier?.set(s.serviceTier ?? state.models.serviceTiers?.[0] ?? 'default');
    visualize?.set(visualizeOn());
    if (reset) reset.disabled = Object.keys(s).length === 0;
  }

  build();
  return {
    focusSearch: () => container.querySelector('input')?.focus(),
    destroy() {
      unsubscribe.forEach((off) => off());
      container.replaceChildren();
    },
  };
}

function field(label, control, hint = null) {
  return h('div', { className: 'picker-field' }, h('span', { className: 'picker-label' }, label), control, hint ? h('p', { className: 'picker-hint' }, hint) : null);
}

// A labelled on/off row: the label and hint sit next to a real checkbox styled as a switch. A checkbox (not a div with
// role=switch) keeps keyboard and screen-reader behaviour for free, and the CSS only changes how it looks.
function switchControl({ label, hint, onChange }) {
  const input = h('input', { type: 'checkbox', className: 'toggle toggle-primary', 'data-testid': 'visualize-toggle', 'aria-label': label });
  input.addEventListener('change', () => onChange(input.checked));
  const el = h(
    'div',
    { className: 'picker-field' },
    h(
      'label',
      { className: 'switch-row' },
      h('span', { className: 'switch-text' }, h('span', { className: 'picker-label' }, label), h('span', { className: 'picker-hint' }, hint)),
      input,
    ),
  );
  return { el, set: (on) => { input.checked = on === true; } };
}
