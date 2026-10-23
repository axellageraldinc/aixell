// Account → Memory & skills: what the agent has learned. Long-term facts, the two note files and the skills folder live in
// the agent's profile on disk, so other clients of the same agent see the same changes.
import { h } from './dom.js';
import { icon } from './icons.js';
import { api, agentPath } from './api.js';
import { state } from './state.js';
import { notify } from './ui.js';
import { fmtDateTime } from './format.js';
import { t } from './i18n.js';

const base = () => `${agentPath(state.agent)}/knowledge`;
const norm = (text) => String(text ?? '').toLowerCase();

// Two clicks to confirm; the label says what will happen and resets itself.
function confirmButton(label, armedLabel, onConfirm, className = 'btn btn-sm') {
  let timer = 0;
  const button = h('button', { type: 'button', className }, label);
  button.addEventListener('click', () => {
    if (!timer) {
      button.textContent = armedLabel;
      timer = setTimeout(() => { timer = 0; button.textContent = label; }, 4000);
      return;
    }
    clearTimeout(timer);
    timer = 0;
    button.textContent = label;
    onConfirm(button);
  });
  return button;
}

const searchBox = (placeholder, onInput) => {
  const input = h('input', { type: 'search', className: 'dlg-search', placeholder, 'aria-label': placeholder });
  input.addEventListener('input', () => onInput(input.value));
  return input;
};

// ---------- facts ----------
async function factsPane(pane) {
  pane.replaceChildren(h('p', { className: 'dlg-note' }, t('common.loading')));
  let { facts } = await api(`${base()}/facts`);
  let query = '';
  const count = h('p', { className: 'dlg-note' });
  const list = h('div', { className: 'kn-list' });
  const draw = () => {
    const shown = facts.filter((f) => !query || norm(f.content).includes(query) || norm(f.category).includes(query) || norm(f.tags).includes(query));
    count.textContent = t('knowledge.facts.count', { n: shown.length, total: facts.length });
    list.replaceChildren(...shown.sort((a, b) => b.fact_id - a.fact_id).map(factRow));
    if (!shown.length) list.append(h('p', { className: 'dlg-note' }, t('common.noMatches')));
  };
  const factRow = (fact) => {
    const text = h('p', { className: 'kn-text' }, fact.content);
    const row = h('div', { className: 'kn-item', 'data-testid': 'fact-row' });
    const meta = h('div', { className: 'kn-meta' }, h('span', { className: 'badge badge-sm badge-soft kn-tag' }, fact.category || 'general'), fact.updated_at ? h('span', {}, fmtDateTime(Date.parse(String(fact.updated_at).replace(' ', 'T') + 'Z') / 1000)) : null);
    const view = () => {
      const edit = h('button', { type: 'button', className: 'ibtn ibtn-sm', 'aria-label': t('knowledge.facts.edit'), title: t('common.edit'), 'data-testid': 'fact-edit' }, icon('square-pen', 14));
      const del = confirmButton(t('common.delete'), t('common.confirmAgainShort'), async (button) => {
        button.disabled = true;
        try { await api(`${base()}/facts/${fact.fact_id}`, { method: 'DELETE' }); facts = facts.filter((f) => f.fact_id !== fact.fact_id); draw(); } catch (err) { notify(err.message); button.disabled = false; }
      }, 'btn btn-sm btn-error btn-soft');
      del.dataset.testid = 'fact-delete';
      edit.addEventListener('click', editor);
      row.replaceChildren(meta, text, h('div', { className: 'kn-actions' }, edit, del));
    };
    const editor = () => {
      const area = h('textarea', { className: 'dlg-text', rows: 3, 'aria-label': t('knowledge.facts.placeholder'), 'data-testid': 'fact-text' });
      area.value = fact.content;
      const save = h('button', { type: 'button', className: 'btn btn-primary btn-sm', 'data-testid': 'fact-save' }, t('common.save'));
      const cancel = h('button', { type: 'button', className: 'btn btn-sm' }, t('common.cancel'));
      cancel.addEventListener('click', view);
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          await api(`${base()}/facts/${fact.fact_id}`, { method: 'PATCH', body: { content: area.value } });
          fact.content = area.value.trim();
          text.textContent = fact.content;
          view();
        } catch (err) { notify(err.message); save.disabled = false; }
      });
      row.replaceChildren(meta, area, h('div', { className: 'kn-actions' }, cancel, save));
      area.focus();
    };
    view();
    return row;
  };
  pane.replaceChildren(searchBox(t('knowledge.facts.search'), (value) => { query = norm(value.trim()); draw(); }), count, list);
  draw();
}

// ---------- notes ----------
const NOTE_TITLES = { memory: [t('knowledge.notes.memory'), t('knowledge.notes.memoryHint')], user: [t('knowledge.notes.user'), t('knowledge.notes.userHint')] };

async function notesPane(pane) {
  pane.replaceChildren(h('p', { className: 'dlg-note' }, t('common.loading')));
  const data = await api(`${base()}/notes`);
  const sections = Object.keys(NOTE_TITLES).map((which) => noteSection(which, data[which]));
  pane.replaceChildren(h('p', { className: 'dlg-note' }, t('knowledge.notes.hint')), ...sections);
}

function noteSection(which, info) {
  const [title, hint] = NOTE_TITLES[which];
  let entries = [...info.entries];
  const list = h('div', { className: 'kn-list' });
  const counter = h('span', { className: 'dlg-count' });
  const save = h('button', { type: 'button', className: 'btn btn-primary btn-sm', 'data-testid': `notes-save-${which}`, disabled: true }, t('common.save'));
  const status = h('span', { className: 'dlg-status', role: 'status' });
  const total = () => entries.map((e) => e.trim()).filter(Boolean).join('\n§\n').length;
  const refresh = () => {
    const used = total();
    counter.textContent = t('knowledge.notes.counter', { used, limit: info.limit });
    counter.classList.toggle('is-over', used > info.limit);
    save.disabled = used > info.limit || JSON.stringify(entries.map((e) => e.trim()).filter(Boolean)) === JSON.stringify(info.entries);
  };
  const draw = () => {
    list.replaceChildren(...entries.map((entry, index) => {
      const area = h('textarea', { className: 'dlg-text kn-note', rows: 2, 'aria-label': t('knowledge.notes.itemLabel', { n: index + 1 }), 'data-testid': `note-${which}` });
      area.value = entry;
      area.addEventListener('input', () => { entries[index] = area.value; status.textContent = ''; refresh(); });
      const remove = h('button', { type: 'button', className: 'ibtn ibtn-sm', 'aria-label': t('knowledge.notes.delete'), title: t('knowledge.notes.delete') }, icon('x', 14));
      remove.addEventListener('click', () => { entries.splice(index, 1); draw(); refresh(); });
      return h('div', { className: 'kn-note-row' }, area, remove);
    }));
    if (!entries.length) list.append(h('p', { className: 'dlg-note' }, t('knowledge.notes.empty')));
  };
  const add = h('button', { type: 'button', className: 'btn btn-sm', 'data-testid': `notes-add-${which}` }, t('knowledge.notes.add'));
  add.addEventListener('click', () => { entries.push(''); draw(); refresh(); list.querySelector('.kn-note-row:last-child textarea')?.focus(); });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const res = await api(`${base()}/notes/${which}`, { method: 'PUT', body: { entries } });
      info = { ...info, entries: res.entries };
      entries = [...res.entries];
      draw();
      status.textContent = t('common.saved');
    } catch (err) { notify(err.message); }
    refresh();
  });
  draw();
  refresh();
  return h('section', {}, h('h3', {}, title), h('p', { className: 'dlg-note' }, hint), list, h('div', { className: 'dlg-row' }, add, h('span', { className: 'dlg-spacer' }), counter, status, save));
}

// ---------- skills ----------
async function skillsPane(pane) {
  pane.replaceChildren(h('p', { className: 'dlg-note' }, t('common.loading')));
  let { skills } = await api(`${base()}/skills`);
  let query = '';
  const count = h('p', { className: 'dlg-note' });
  const list = h('div', { className: 'kn-list' });
  const draw = () => {
    const shown = skills.filter((s) => !query || norm(s.name).includes(query) || norm(s.description).includes(query) || norm(s.category).includes(query));
    const local = skills.filter((s) => !s.builtin).length;
    count.textContent = t('knowledge.skills.count', { n: skills.length, local });
    list.replaceChildren(...shown.map(skillRow));
    if (!shown.length) list.append(h('p', { className: 'dlg-note' }, t('common.noMatches')));
  };
  const skillRow = (skill) => {
    const body = h('pre', { className: 'dlg-soul', hidden: true });
    const toggle = h('button', { type: 'button', className: 'kn-skill-head', 'aria-expanded': 'false', 'data-testid': 'skill-row' },
      h('span', { className: 'kn-name' }, skill.name),
      h('span', { className: `badge badge-sm badge-soft kn-tag${skill.builtin ? '' : ' is-local badge-success'}` }, skill.builtin ? t('knowledge.skills.builtin') : t('knowledge.skills.local')),
      skill.category ? h('span', { className: 'kn-cat' }, skill.category) : null);
    toggle.addEventListener('click', async () => {
      const open = body.hidden;
      toggle.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      if (open && !body.textContent) {
        body.textContent = t('common.loading');
        try { body.textContent = (await api(`${base()}/skills/read?path=${encodeURIComponent(skill.path)}`)).content; } catch (err) { body.textContent = err.message; }
      }
    });
    const actions = skill.builtin ? null : h('div', { className: 'kn-actions' }, confirmButton(t('knowledge.skills.delete'), t('common.confirmAgainShort'), async (button) => {
      button.disabled = true;
      try { await api(`${base()}/skills/item?path=${encodeURIComponent(skill.path)}`, { method: 'DELETE' }); skills = skills.filter((s) => s !== skill); draw(); notify(t('knowledge.skills.deleted')); } catch (err) { notify(err.message); button.disabled = false; }
    }, 'btn btn-sm btn-error btn-soft'));
    return h('div', { className: 'kn-item' }, toggle, skill.description ? h('p', { className: 'kn-text' }, skill.description) : null, body, actions);
  };
  pane.replaceChildren(searchBox(t('knowledge.skills.search'), (value) => { query = norm(value.trim()); draw(); }), count, list);
  draw();
}

// ---------- dialog ----------
export function openKnowledge() {
  if (!state.agent) return;
  const opener = document.activeElement;
  const pane = h('div', { className: 'dlg-body kn-pane' });
  const tabs = h('div', { className: 'up-tabs tabs tabs-box tabs-sm', role: 'tablist' });
  const close = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('common.close'), onClick: () => shut() }, icon('x', 18));
  const panel = h('div', { className: 'modal-box dlg-panel dlg-knowledge', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('knowledge.title'), 'data-testid': 'knowledge' },
    h('div', { className: 'dlg-head' }, h('h2', {}, t('knowledge.title')), close), h('div', { className: 'kn-tabs' }, tabs), pane);
  const overlay = h('div', { className: 'dlg modal modal-open' }, panel);
  const shut = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); opener?.focus?.(); };
  const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); shut(); } };
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) shut(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  close.focus();

  const TABS = [['facts', t('knowledge.tab.facts'), factsPane], ['notes', t('knowledge.tab.notes'), notesPane], ['skills', t('knowledge.tab.skills'), skillsPane]];
  let token = 0;
  const select = async (key) => {
    const mine = ++token;
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.key === key));
    const fill = h('div', {});
    pane.replaceChildren(fill);
    try { await TABS.find((tab) => tab[0] === key)[2](fill); } catch (err) { if (mine === token) fill.replaceChildren(h('p', { className: 'dlg-note' }, err.message)); }
  };
  for (const [key, label] of TABS) tabs.append(h('button', { type: 'button', role: 'tab', className: 'up-tab tab', 'data-key': key, 'data-testid': `kn-tab-${key}`, onClick: () => select(key) }, label));
  select('facts');
}
