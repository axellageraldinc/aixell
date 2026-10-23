// Prompt templates: typing "/" at the start of the composer opens a menu; picking one puts its text in the box.
// The list lives on the server (shared by phone and desktop) and is edited in Settings → Templates.
import { t } from './i18n.js';
import { h, $ } from './dom.js';
import { api, agentPath } from './api.js';
import { state, on } from './state.js';
import { notify } from './ui.js';

let list = null;
let loading = null;

export async function loadTemplates(force = false) {
  if (list && !force) return list;
  loading ??= api(`${agentPath(state.agent)}/templates`).then((res) => { list = res.templates ?? []; return list; }).finally(() => { loading = null; });
  return loading;
}

// ----- slash menu -----
export function initSlashMenu({ input, after }) {
  const menu = h('div', { className: 'pop slash-menu', role: 'listbox', 'aria-label': t('templates.title'), hidden: true, 'data-testid': 'slash-menu' });
  $('.dock').append(menu);
  let shown = [];
  let active = 0;

  const close = () => { menu.hidden = true; shown = []; };
  const paint = () => {
    menu.replaceChildren(...shown.map((t, i) => h('button', {
      type: 'button', role: 'option', className: 'slash-item', 'aria-selected': String(i === active), 'data-testid': 'slash-item',
      onmousedown: (event) => { event.preventDefault(); pick(t); },
    }, h('span', { className: 'slash-name' }, `/${t.name}`), h('span', { className: 'slash-text' }, t.text.replace(/\s+/g, ' ').trim()))));
    menu.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (template) => {
    close();
    input.value = template.text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    after();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };
  const refresh = async () => {
    const m = /^\/([\p{L}\p{N}_-]*)$/u.exec(input.value);
    if (!m || input.disabled) return close();
    const all = await loadTemplates().catch(() => []);
    if (!/^\/([\p{L}\p{N}_-]*)$/u.test(input.value)) return;
    const q = m[1].toLowerCase();
    shown = all.filter((template) => template.name.startsWith(q)).concat(all.filter((template) => !template.name.startsWith(q) && template.name.includes(q)));
    active = 0;
    if (!shown.length) return close();
    menu.hidden = false;
    paint();
  };
  input.addEventListener('input', refresh);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (event) => {
    if (menu.hidden) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      active = (active + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      paint();
    } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      event.preventDefault();
      event.stopImmediatePropagation();
      pick(shown[active]);
    } else if (event.key === 'Escape') {
      event.stopImmediatePropagation();
      close();
    }
  }, true);
  on('agent:select', () => { list = null; });
}

// ----- editor (Settings → Templates) -----
export function templateEditor() {
  const rows = h('div', { className: 'tpl-rows' });
  const status = h('span', { className: 'dlg-status', role: 'status' });
  const save = h('button', { type: 'button', className: 'btn btn-sm btn-primary', 'data-testid': 'tpl-save' }, t('common.save'));
  const add = h('button', { type: 'button', className: 'btn btn-sm', 'data-testid': 'tpl-add', onclick: () => rows.append(row({ name: '', text: '' })) }, t('templates.add'));

  function row(tpl) {
    const name = h('input', { className: 'input input-sm tpl-name', value: tpl.name, placeholder: t('templates.namePlaceholder'), maxlength: 24, 'aria-label': t('templates.nameLabel'), 'data-testid': 'tpl-name' });
    const text = h('textarea', { className: 'dlg-text tpl-text', rows: 3, maxlength: 4000, placeholder: t('templates.textPlaceholder'), 'aria-label': t('templates.textLabel'), 'data-testid': 'tpl-text' });
    text.value = tpl.text;
    const del = h('button', { type: 'button', className: 'btn btn-sm btn-ghost btn-error', 'aria-label': t('templates.delete'), onclick: () => item.remove() }, t('common.delete'));
    const item = h('div', { className: 'tpl-row', 'data-testid': 'tpl-row' }, h('div', { className: 'tpl-head' }, h('span', { className: 'tpl-slash' }, '/'), name, h('span', { className: 'dlg-spacer' }), del), text);
    return item;
  }

  save.addEventListener('click', async () => {
    const templates = [...rows.children].map((r) => ({ name: r.querySelector('.tpl-name').value, text: r.querySelector('.tpl-text').value })).filter((tpl) => tpl.name.trim() || tpl.text.trim());
    save.disabled = true;
    try {
      const res = await api(`${agentPath(state.agent)}/templates`, { method: 'PUT', body: { templates } });
      list = res.templates;
      status.textContent = t('common.saved');
    } catch (err) {
      status.textContent = err.message;
      notify(err.message);
    } finally {
      save.disabled = false;
    }
  });

  loadTemplates(true).then((all) => rows.replaceChildren(...all.map(row))).catch((err) => rows.replaceChildren(h('p', { className: 'dlg-note' }, err.message)));
  return h('section', {}, h('h3', {}, t('templates.title')),
    h('p', { className: 'dlg-note' }, t('templates.hint')),
    rows, h('div', { className: 'dlg-row' }, add, h('span', { className: 'dlg-spacer' }), status, save));
}
