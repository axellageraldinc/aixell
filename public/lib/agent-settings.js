// Account → Settings: one dialog for everything that is adjustable. Appearance is per browser; personality and voice
// language belong to this web agent only; the shared parts are shown read-only so it is clear where to change them.
import { h } from './dom.js';
import { icon } from './icons.js';
import { api, agentPath } from './api.js';
import { state } from './state.js';
import { loadModels } from './models.js';
import { notify } from './ui.js';
import { agentLabel } from './format.js';
import { templateEditor } from './templates.js';
import { budgetEditor } from './budget.js';
import { SIZES, currentSize, setSize, isFocus, setFocus } from './display.js';
import { currentTheme, setTheme } from './theme.js';
import { getMicMode, setMicMode, speechSupported } from './recorder.js';
import { appVersion, latestVersion, hardReload } from './version.js';
import { diagOn, setDiag } from './diag.js';
import { THRESHOLDS, pushState, enablePush, disablePush, sendTestPush } from './push.js';
import { t } from './i18n.js';

const MAX = 4000;
const PLACEHOLDER = t('settings.agent.personality.placeholder');

export async function openSettings({ signOutAll } = {}) {
  const agent = state.agent;
  if (!agent) return;
  const opener = document.activeElement;
  const body = h('div', { className: 'dlg-body' }, h('p', { className: 'dlg-note' }, t('common.loading')));
  const close = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('common.close'), onClick: () => shut() }, icon('x', 18));
  const panel = h('div', { className: 'modal-box dlg-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('settings.title'), 'data-testid': 'settings' },
    h('div', { className: 'dlg-head' }, h('h2', {}, t('settings.title')), close), body);
  const overlay = h('div', { className: 'dlg modal modal-open' }, panel);
  const shut = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); opener?.focus?.(); };
  const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); shut(); } };
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) shut(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  close.focus();

  const segmented = (label, options, current, onPick) => {
    const group = h('div', { className: 'up-tabs tabs tabs-box tabs-sm', role: 'radiogroup', 'aria-label': label });
    const paint = (value) => group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.value === value)));
    for (const [value, text] of options) group.append(h('button', { type: 'button', role: 'radio', className: 'up-tab tab', 'data-value': value, 'data-testid': `${label}-${value}`, onclick: () => { paint(value); onPick(value); } }, text));
    paint(current);
    return group;
  };

  let data;
  try { data = await api(`${agentPath(agent)}/settings`); } catch (err) { body.replaceChildren(h('p', { className: 'dlg-note' }, err.message)); return; }
  if (!overlay.isConnected) return;

  const text = h('textarea', { className: 'dlg-text', rows: 7, maxlength: MAX, placeholder: PLACEHOLDER, 'data-testid': 'personality-input', 'aria-label': t('settings.agent.personality.label') });
  text.value = data.personality;
  const count = h('span', { className: 'dlg-count' });
  const save = h('button', { type: 'button', className: 'btn btn-primary btn-sm', 'data-testid': 'personality-save', disabled: true }, t('common.save'));
  const status = h('span', { className: 'dlg-status', role: 'status' });
  let saved = data.personality;
  const refresh = () => { count.textContent = `${text.value.length} / ${MAX}`; save.disabled = text.value.trim() === saved; };
  text.addEventListener('input', () => { status.textContent = ''; refresh(); });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const res = await api(`${agentPath(agent)}/settings`, { method: 'PUT', body: { personality: text.value } });
      saved = res.personality;
      status.textContent = t('settings.agent.personality.saved');
    } catch (err) { notify(err.message); }
    refresh();
  });
  refresh();

  // Default model + effort for chats in this web app (stored by the web server; applies at once, no restart).
  const defaults = data.defaults ?? { model: '', provider: '', effort: '' };
  const defaultStatus = h('span', { className: 'dlg-status', role: 'status' });
  let catalogue = null;
  try { catalogue = await api(`${agentPath(agent)}/models`); } catch { /* the select then offers only "follow Hermes" */ }
  const choices = (catalogue?.models ?? []).filter((m) => !m.hidden || m.id === defaults.model);
  const defaultModelSel = h('select', { className: 'input input-sm set-select', 'aria-label': t('settings.agent.model.label'), 'data-testid': 'default-model' },
    h('option', { value: '' }, `${t('settings.agent.model.follow')}${catalogue?.agentDefault?.model ? ` (${catalogue.agentDefault.model})` : ''}`),
    ...choices.map((m) => h('option', { value: m.id, 'data-provider': m.provider ?? '' }, m.id)));
  defaultModelSel.value = choices.some((m) => m.id === defaults.model) ? defaults.model : '';
  const effortOptions = [['', t('settings.effort.default')], ...((catalogue?.effortLevels ?? ['none', 'low', 'medium', 'high', 'max']).map((l) => [l, l]))];
  const saveDefaults = async (patch) => {
    try {
      const res = await api(`${agentPath(agent)}/settings`, { method: 'PUT', body: patch });
      Object.assign(defaults, res.defaults);
      defaultStatus.textContent = t('settings.agent.model.saved');
      loadModels({ silent: true });
    } catch (err) { notify(err.message); }
  };
  const defaultEffortSeg = segmented('default-effort', effortOptions, defaults.effort, (value) => saveDefaults({ defaultEffort: value }));
  defaultEffortSeg.classList.add('set-wrap');
  defaultModelSel.addEventListener('change', () => {
    const option = defaultModelSel.selectedOptions[0];
    saveDefaults({ defaultModel: defaultModelSel.value, defaultProvider: option?.dataset.provider ?? '' });
  });
  const coversToggle = h('input', { type: 'checkbox', className: 'toggle toggle-primary', 'data-testid': 'covers-toggle', 'aria-label': t('settings.agent.covers.label') });
  coversToggle.checked = data.coversEnabled !== false;
  coversToggle.addEventListener('change', () => saveDefaults({ coversEnabled: coversToggle.checked }));
  const soul = h('pre', { className: 'dlg-soul' }, data.soul || '(empty)');
  const sizeSeg = segmented('fontsize', SIZES, currentSize(), setSize);
  const focusToggle = h('input', { type: 'checkbox', className: 'toggle toggle-primary', 'data-testid': 'focus-toggle', 'aria-label': t('settings.display.focus') });
  focusToggle.checked = isFocus();
  focusToggle.addEventListener('change', () => setFocus(focusToggle.checked));
  const themeSeg = segmented('theme', [['light', t('settings.display.theme.light')], ['dark', t('settings.display.theme.dark')], ['auto', t('settings.display.theme.system')]], currentTheme(), setTheme);
  const voiceStatus = h('span', { className: 'dlg-status', role: 'status' });
  const voiceSeg = segmented('voice', [['en', 'English'], ['auto', t('common.auto')]], data.sttLanguage ?? 'auto', async (value) => {
    try {
      await api(`${agentPath(agent)}/settings`, { method: 'PUT', body: { sttLanguage: value } });
      voiceStatus.textContent = t('common.saved');
    } catch (err) { notify(err.message); }
  });
  const micSeg = segmented('mic', [['auto', t('common.auto')], ['dictation', t('settings.voice.mic.dictation')], ['record', t('settings.voice.mic.record')]], getMicMode(), setMicMode);
  const pushStatus = h('span', { className: 'dlg-status', role: 'status' });
  const pushTest = h('button', { type: 'button', className: 'btn btn-sm', 'data-testid': 'push-test', hidden: true }, t('settings.notify.test'));
  const pushSeg = segmented('push', [['off', t('settings.notify.threshold.off')], ...THRESHOLDS.map(([value, text]) => [String(value), text])], 'off', async (value) => {
    pushStatus.textContent = '';
    try {
      if (value === 'off') { await disablePush(); pushTest.hidden = true; pushStatus.textContent = t('settings.notify.off'); return; }
      await enablePush(Number(value));
      pushTest.hidden = false;
      pushStatus.textContent = t('settings.notify.on');
    } catch (err) {
      notify(err.message);
      pushSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.value === 'off')));
    }
  });
  pushTest.addEventListener('click', async () => {
    pushTest.disabled = true;
    try { await sendTestPush(); pushStatus.textContent = t('settings.notify.testSent'); } catch (err) { notify(err.message); }
    pushTest.disabled = false;
  });
  pushState().then((st) => {
    if (!overlay.isConnected) return;
    if (!st.supported) { pushSeg.querySelectorAll('button').forEach((b) => { b.disabled = true; }); pushStatus.textContent = t('settings.notify.unsupported'); return; }
    const active = st.subscribed && st.permission === 'granted' ? String(st.minSeconds) : 'off';
    pushSeg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.value === active)));
    pushTest.hidden = active === 'off';
    if (st.permission === 'denied') pushStatus.textContent = t('settings.notify.blocked');
  });
  const versionNote = h('p', { className: 'dlg-note', 'data-testid': 'app-version' }, `${t('settings.version.current', { version: appVersion ?? t('common.unknown') })} ${t('settings.version.checking')}`);
  const reloadButton = h('button', { type: 'button', className: 'btn btn-sm', 'data-testid': 'app-reload' }, t('settings.version.reload'));
  reloadButton.addEventListener('click', hardReload);
  const diagButton = h('button', { type: 'button', className: 'btn btn-sm', 'data-testid': 'diag-toggle' }, diagOn() ? t('settings.diag.off') : t('settings.diag.on'));
  diagButton.addEventListener('click', () => { const next = !diagOn(); setDiag(next); diagButton.textContent = next ? t('settings.diag.off') : t('settings.diag.on'); });
  latestVersion().then((latest) => {
    if (!versionNote.isConnected) return;
    const state = !latest ? t('settings.version.checkFailed') : latest === appVersion ? t('settings.version.latest') : t('settings.version.available', { latest });
    versionNote.textContent = `${t('settings.version.current', { version: appVersion ?? t('common.unknown') })} ${state}`;
  });
  let armed = false;
  const everywhere = h('button', { type: 'button', className: 'btn btn-sm btn-error btn-soft', 'data-testid': 'sign-out-everywhere', onclick: () => {
    if (!armed) { armed = true; everywhere.textContent = t('common.confirmAgain'); setTimeout(() => { armed = false; everywhere.textContent = t('account.signOutAll'); }, 4000); return; }
    signOutAll?.();
  } }, t('account.signOutAll'));
  const sections = {
    'display': [
    h('section', {},
      h('h3', {}, t('settings.display.title')),
      h('p', { className: 'dlg-note' }, t('settings.display.deviceOnly')),
      themeSeg,
      h('h3', { className: 'set-sub' }, t('settings.display.textSize.title')),
      sizeSeg,
      h('label', { className: 'switch-row set-focus' },
        h('span', { className: 'switch-text' }, h('span', { className: 'picker-label' }, t('settings.display.focus')), h('span', { className: 'picker-hint' }, t('settings.display.focus.hint'))),
        focusToggle)),
    h('section', {},
      h('h3', {}, t('settings.version.title')),
      versionNote,
      h('div', { className: 'dlg-row' }, diagButton, h('span', { className: 'dlg-spacer' }), reloadButton)),
    ],
    agent: [
    h('section', {},
      h('h3', {}, t('settings.agent.personality.title')),
      h('p', { className: 'dlg-note' }, t('settings.agent.personality.hint')),
      text,
      h('div', { className: 'dlg-row' }, count, h('span', { className: 'dlg-spacer' }), status, save)),
    h('section', {},
      h('h3', {}, t('settings.agent.shared.title')),
      h('p', { className: 'dlg-note' }, t('settings.agent.shared.hint')),
      h('ul', { className: 'dlg-shared' }, data.items.map((item) => h('li', { className: item.shared ? 'is-shared' : 'is-own' },
        icon(item.shared ? 'check' : 'x', 14), h('span', {}, item.label), h('em', {}, item.shared ? t('settings.agent.shared.live') : t('settings.agent.shared.separate'))))),
      h('details', { className: 'dlg-details' }, h('summary', {}, t('settings.agent.soul.title')), soul)),
    h('section', {},
      h('h3', {}, t('settings.agent.model.title')),
      h('p', { className: 'dlg-note' }, t('settings.agent.model.hint', { model: data.model ?? '—', provider: data.provider ? ` · ${data.provider}` : '' })),
      defaultModelSel, defaultEffortSeg, h('div', { className: 'dlg-row' }, defaultStatus)),
    h('section', {},
      h('h3', {}, t('settings.agent.covers.title')),
      h('label', { className: 'switch-row set-focus' },
        h('span', { className: 'switch-text' }, h('span', { className: 'picker-label' }, t('settings.agent.covers.toggle')), h('span', { className: 'picker-hint' }, t('settings.agent.covers.hint'))),
        coversToggle)),
    ],
    voice: [
    h('section', {},
      h('h3', {}, t('settings.voice.mode.title')),
      h('p', { className: 'dlg-note' }, t('settings.voice.mode.hint')),
      micSeg,
      speechSupported ? null : h('p', { className: 'dlg-note' }, t('settings.voice.dictationUnsupported'))),
    h('section', {},
      h('h3', {}, t('settings.voice.language.title')),
      h('p', { className: 'dlg-note' }, t('settings.voice.language.hint')),
      voiceSeg, h('div', { className: 'dlg-row' }, voiceStatus)),
    ],
    templates: [templateEditor()],
    budget: [budgetEditor()],
    notifications: [
    h('section', {},
      h('h3', {}, t('settings.notify.title')),
      h('p', { className: 'dlg-note' }, t('settings.notify.hint')),
      pushSeg, h('div', { className: 'dlg-row' }, pushStatus, h('span', { className: 'dlg-spacer' }), pushTest)),
    ],
    account: [
    h('section', {},
      h('h3', {}, t('settings.account.title')),
      h('p', { className: 'dlg-note' }, t('settings.account.signOutAll.hint')),
      everywhere),
    ],
  };
  // Five tabs fit a phone: device things (look, sound, notifications) share one.
  const groups = {
    display: { label: t('settings.tab.display'), sections: [...sections.display, ...sections.voice, ...sections.notifications] },
    agent: { label: t('settings.tab.agent'), sections: sections.agent },
    templates: { label: t('settings.tab.templates'), sections: sections.templates },
    budget: { label: t('settings.tab.budget'), sections: sections.budget },
    account: { label: t('settings.tab.account'), sections: sections.account },
  };
  const tabs = h('div', { className: 'dlg-tabs set-tabs tabs tabs-box tabs-sm', role: 'tablist' });
  const pane = h('div', { className: 'set-pane' });
  const select = (key) => {
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.key === key));
    pane.replaceChildren(...groups[key].sections);
    tabs.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    fade();
    body.scrollTop = 0;
  };
  for (const [key, group] of Object.entries(groups)) tabs.append(h('button', { type: 'button', role: 'tab', className: 'tab', 'data-key': key, 'data-testid': `set-tab-${key}`, onclick: () => select(key) }, group.label));
  const fade = () => {
    tabs.classList.toggle('is-scrollable', tabs.scrollWidth > tabs.clientWidth + 2);
    tabs.classList.toggle('is-end', tabs.scrollLeft + tabs.clientWidth >= tabs.scrollWidth - 2);
  };
  tabs.addEventListener('scroll', fade, { passive: true });
  body.before(tabs);
  body.replaceChildren(pane);
  select('display');
}
