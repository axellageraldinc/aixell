// "Sources and taste": which sites feed the timeline (grouped by category; add your own by pasting an address), Bluesky, Steam
// and X (paid: the switch, today's calls and cost, the accounts it learned), how often it checks, what you taught it with
// "more / less like this", and how a Hermes worker can send stories from places that need a login.
import { h } from './dom.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { notify } from './ui.js';
import { copyText } from './clipboard.js';
import { t } from './i18n.js';
import { fmtMoney } from './format.js';

const INTERVALS = [[15, t('feed.interval.15')], [30, t('feed.interval.30')], [60, t('feed.interval.60')], [180, t('feed.interval.180')]];

export async function openFreshSources({ onChange, onOrder } = {}) {
  const opener = document.activeElement;
  let changed = false;
  const body = h('div', { className: 'dlg-body' }, h('p', { className: 'dlg-note' }, t('common.loading')));
  const close = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('common.close'), onClick: () => shut() }, icon('x', 18));
  const panel = h('div', { className: 'modal-box dlg-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('feed.settings.title'), 'data-testid': 'fresh-sources-dialog' },
    h('div', { className: 'dlg-head' }, h('h2', {}, t('feed.settings.title')), close), body);
  const overlay = h('div', { className: 'dlg modal modal-open' }, panel);
  const shut = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); opener?.focus?.(); if (changed) onChange?.(); };
  const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); shut(); } };
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) shut(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  close.focus();

  const money = (n, currency) => fmtMoney(n ?? 0, currency, 0);
  const SLOT_LABEL = {
    models: t('feed.slot.models'),
    tools: t('feed.slot.tools'),
    local: t('feed.slot.local'),
    hosting: t('feed.slot.hosting'),
    pcgaming: t('feed.slot.pcgaming'),
    id: t('feed.slot.id'),
  };

  const SLOT_STATE = {
    pending: t('feed.slotState.pending'),
    due: t('feed.slotState.pending'),
    running: t('feed.slotState.running'),
    done: t('feed.slotState.done'),
    error: t('feed.slotState.error'),
    missed: t('feed.slotState.missed'),
    skipped: t('feed.slotState.skipped'),
  };
  const SKIP_WHY = {
    cap: t('feed.skipReason.cap'),
    'owner away': t('feed.skipReason.away'),
    'pool full': t('feed.skipReason.pool'),
  };
  function slotLine(sl) {
    let state = SLOT_STATE[sl.state] ?? sl.state;
    if (sl.state === 'done') state += ` (${t('feed.items', { count: sl.items })})`;
    else if (sl.state === 'skipped' && sl.reason) state += ` (${SKIP_WHY[sl.reason] ?? sl.reason})`;
    return h('li', { 'data-state': sl.state }, h('b', {}, `${String(sl.hourLocal).padStart(2, '0')}.00`), h('span', {}, SLOT_LABEL[sl.type] ?? sl.type), h('em', {}, state));
  }

  // X is paid (each call costs money) and capped per day; the switch below is the kill switch.
  function xBlock(data) {
    const x = data.x ?? {};
    const on = h('input', { type: 'checkbox', className: 'toggle toggle-sm', 'aria-label': t('feed.x.enable'), 'data-testid': 'fresh-x-enabled' });
    on.checked = Boolean(x.enabled);
    on.addEventListener('change', async () => {
      try {
        await api('/api/fresh/settings', { method: 'PUT', body: { x: { enabled: on.checked } } });
        await api('/api/fresh/sources/x', { method: 'PATCH', body: { on: on.checked } });
        changed = true;
        notify(on.checked ? t('feed.x.on') : t('feed.x.off'));
      } catch (e) { on.checked = !on.checked; notify(e.message); }
    });
    const handles = (label, list) => (list?.length ? h('p', { className: 'fr-s-handles' }, h('b', {}, `${label} (${list.length}): `), list.map((n) => `@${n}`).join(', ')) : null);
    const learned = [handles(t('feed.x.handles.used'), x.handles?.allowed), handles(t('feed.x.handles.skipped'), x.handles?.excluded), handles(t('feed.x.handles.id'), x.handles?.id)].filter(Boolean);
    return h('div', { className: 'fr-s-x', 'data-testid': 'fresh-x' },
      h('label', { className: 'fr-s-row' }, h('span', { className: 'fr-s-name' }, h('b', {}, t('feed.x.title', { provider: x.provider || 'search provider' })), h('small', {}, t('feed.x.subtitle'))), on),
      h('p', { className: 'fr-s-cost', 'data-testid': 'fresh-x-cost' }, t('feed.x.today', { n: x.callsToday ?? 0, cap: x.cap ?? 7, cost: money(x.costToday, x.currency) }), h('br'), t('feed.x.month', { n: x.callsMonth ?? 0, cost: money(x.costMonth, x.currency) })),
      x.slots?.length ? h('ul', { className: 'fr-s-slots', 'data-testid': 'fresh-x-slots' }, x.slots.map(slotLine)) : null,
      h('details', { className: 'dlg-details', 'data-testid': 'fresh-x-handles' }, h('summary', {}, t('feed.x.learned')),
        learned.length ? learned : h('p', { className: 'dlg-note' }, t('feed.x.learned.empty'))));
  }

  // Per model: requests in the last minute (against the limit), calls and 429s in the last hour, time spent waiting for a slot.
  const MODEL_SHORT = { 'jev-1-13:free': 'jev', 'clef:free': 'clef', 'clef-flash:free': 'clef-flash', 'deepseek-v4-1-flash:free': 'writer free' };
  function modelLines(llm) {
    const rows = Object.entries(llm?.models ?? {});
    if (!rows.length) return null;
    return h('div', { 'data-testid': 'fresh-models' }, rows.map(([name, m]) => h('p', { className: 'fr-s-handles', 'data-model': name },
      h('b', {}, `${MODEL_SHORT[name] ?? name}: `), `${t('feed.metrics.perMinute', { n: m.perMin, limit: m.limit })} · ${t('feed.metrics.callsHour', { n: m.calls1h })} · 429: ${m.r429_1h} · ${t('feed.metrics.waited', { n: Math.round((m.waitedMs1h ?? 0) / 1000) })}${m.pausedS ? ` · ${t('feed.metrics.paused', { n: m.pausedS })}` : ''}`)));
  }
  const writerCounts = (llm) => (llm ? {
    [t('feed.writerStats.free')]: llm.free,
    [t('feed.writerStats.paid')]: llm.paid,
    [t('feed.writerStats.paidLimit')]: llm.paidDueToLimit,
    [t('feed.writerStats.paidQuality')]: llm.paidDueToQuality,
    [t('feed.writerStats.dueError')]: llm.paidDueToError,
    [t('feed.writerStats.deferred')]: llm.deferredByLimit,
    [t('feed.writerStats.rejected')]: llm.rejected,
    [t('feed.writerStats.written')]: llm.written,
  } : null);

  // A small, collapsed look at what the engine has been doing (models, X, Bluesky, Steam); filled in when opened.
  function status() {
    const out = h('div', { className: 'fr-s-status' }, h('p', { className: 'dlg-note' }, t('common.loading')));
    const box = h('details', { className: 'dlg-details', 'data-testid': 'fresh-status' }, h('summary', {}, t('feed.engine.title')), out);
    const line = (name, obj) => {
      const parts = Object.entries(obj ?? {}).filter(([, v]) => ['number', 'string', 'boolean'].includes(typeof v) && v !== '').slice(0, 10).map(([k, v]) => `${k}: ${v}`);
      return parts.length ? h('p', { className: 'fr-s-handles' }, h('b', {}, `${name}: `), parts.join(' · ')) : null;
    };
    box.addEventListener('toggle', async () => {
      if (!box.open || box.dataset.loaded) return;
      box.dataset.loaded = '1';
      try {
        const st = await api('/api/fresh/status');
        out.replaceChildren(...[modelLines(st.llm), line(t('feed.engine.writer'), writerCounts(st.llm)), line('X', { active: st.x?.enabled, today: st.x?.callsToday }), line('Bluesky', st.bluesky), line('Steam', st.steam)].filter(Boolean));
      } catch (e) { out.replaceChildren(h('p', { className: 'dlg-note' }, e.message)); }
    });
    return box;
  }


  // The order of the category chips: drag a handle (pointer events: mouse, pen and touch) or use the arrow buttons / arrow keys.
  // Saved on the server at once, so every device shows the same bar.
  function orderBlock(data) {
    const label = { ...data.categories, saved: t('feed.chip.saved') };
    let order = data.catOrder ?? Object.keys(label);
    const ul = h('ul', { className: 'fr-s-order', 'data-testid': 'fresh-order' });
    const say = h('small', { className: 'fr-s-say', role: 'status' });
    const same = (a, b) => a.join() === b.join();
    async function save(next) {
      const before = order;
      order = next;
      try {
        const res = await api('/api/fresh/settings', { method: 'PUT', body: { catOrder: next } });
        order = res.catOrder ?? next;
        onOrder?.(order);
      } catch (e) { order = before; draw(); notify(e.message); }
    }
    function shift(id, by, focus) {
      const from = order.indexOf(id);
      const to = from + by;
      if (to < 0 || to >= order.length) return;
      const next = order.slice();
      next.splice(to, 0, next.splice(from, 1)[0]);
      say.textContent = t('feed.order.announce', { label: label[id], n: to + 1, total: next.length });
      save(next);
      order = next;
      draw(`${id}:${focus}`);
    }
    function row(id, i) {
      const grip = h('button', { type: 'button', className: 'fr-s-grip', 'aria-label': t('feed.order.grab', { label: label[id] }), 'data-grip': id }, icon('grip', 18));
      const up = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('feed.order.up', { label: label[id] }), 'data-up': id, disabled: i === 0, onClick: () => shift(id, -1, 'up') }, icon('chevron-up', 18));
      const down = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('feed.order.down', { label: label[id] }), 'data-down': id, disabled: i === order.length - 1, onClick: () => shift(id, 1, 'down') }, icon('chevron-down', 18));
      const li = h('li', { className: 'fr-s-orow', 'data-id': id }, grip, h('span', { className: 'fr-s-name' }, h('b', {}, label[id])), up, down);
      grip.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        shift(id, event.key === 'ArrowUp' ? -1 : 1, 'grip');
      });
      grip.addEventListener('pointerdown', (event) => {
        if (event.button > 0) return;
        event.preventDefault();
        ul.setPointerCapture(event.pointerId); // the list, not the handle: moving a row in the DOM would drop the capture
        li.classList.add('dragging');
        const move = (e) => {
          const target = [...ul.children].filter((x) => x !== li).find((x) => { const r = x.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
          if ((target ?? null) !== li.nextElementSibling) ul.insertBefore(li, target ?? null);
        };
        const end = () => {
          ul.removeEventListener('pointermove', move);
          ul.removeEventListener('pointerup', end);
          ul.removeEventListener('pointercancel', end);
          li.classList.remove('dragging');
          const next = [...ul.children].map((x) => x.dataset.id);
          if (!same(next, order)) { say.textContent = t('feed.order.moved', { label: label[id], n: next.indexOf(id) + 1, total: next.length }); save(next); order = next; }
          draw();
        };
        ul.addEventListener('pointermove', move);
        ul.addEventListener('pointerup', end);
        ul.addEventListener('pointercancel', end);
      });
      return li;
    }
    function draw(focus) {
      ul.replaceChildren(...order.map(row));
      if (focus) { const [id, what] = focus.split(':'); (ul.querySelector(`[data-${what}="${id}"]:not([disabled])`) ?? ul.querySelector(`[data-grip="${id}"]`))?.focus(); }
    }
    draw();
    return h('section', { 'data-section': 'order' }, h('h3', {}, t('feed.order.title')),
      h('p', { className: 'dlg-note' }, t('feed.order.hint')), ul, say);
  }

  // The categories themselves: add, rename, retime and remove. Written to the data directory and live at once (no restart).
  function categoriesBlock(editor) {
    const rows = editor.categories.map((c) => ({ ...c, keywords: { ...c.keywords }, saved: true }));
    const list = h('div', { className: 'fr-s-cats', 'data-testid': 'fresh-categories' });
    const say = h('small', { className: 'fr-s-say', role: 'status' });
    const slug = (text) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'topic';
    const uniqueId = (base) => { let id = base; for (let n = 2; rows.some((r) => r.id === id) || id === 'all' || id === 'saved'; n += 1) id = `${base.slice(0, 20)}-${n}`; return id; };
    function rowView(row, i) {
      const name = h('input', { type: 'text', className: 'input input-sm', value: row.label, maxlength: 40, 'aria-label': t('feed.cats.name'), placeholder: t('feed.cats.name') });
      name.addEventListener('input', () => { row.label = name.value; });
      const hours = h('input', { type: 'number', className: 'input input-sm', value: String(row.halfLifeHours), min: 1, max: 240, 'aria-label': t('feed.cats.halfLife') });
      hours.addEventListener('input', () => { row.halfLifeHours = Number(hours.value); });
      const kw = (key, label) => {
        const area = h('textarea', { className: 'textarea textarea-sm', rows: 2, spellcheck: 'false', 'aria-label': label, placeholder: label }, row.keywords[key]);
        area.addEventListener('input', () => { row.keywords[key] = area.value; });
        return area;
      };
      const remove = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('feed.cats.remove', { label: row.label || row.id }), disabled: rows.length <= 1, onClick: () => {
        if (row.saved && !window.confirm(t('feed.cats.confirmRemove', { label: row.label || row.id }))) return;
        rows.splice(i, 1); draw();
      } }, icon('trash', 16));
      return h('div', { className: 'fr-s-catrow', 'data-id': row.id },
        h('div', { className: 'fr-s-catmain' }, name, h('label', { className: 'fr-s-hours' }, hours, h('small', {}, t('feed.cats.hours'))), remove),
        h('details', { className: 'dlg-details' }, h('summary', {}, t('feed.cats.keywords')),
          h('p', { className: 'dlg-note' }, t('feed.cats.keywordsHint')), kw('pos', t('feed.cats.pos')), kw('neg', t('feed.cats.neg'))));
    }
    function draw() { list.replaceChildren(...rows.map(rowView)); }
    const add = h('button', { type: 'button', className: 'btn btn-sm', 'data-testid': 'fresh-cat-add', onClick: () => {
      rows.push({ id: '', label: '', halfLifeHours: 24, keywords: { pos: '', neg: '' }, saved: false });
      draw();
      list.lastElementChild.querySelector('input')?.focus();
    } }, t('feed.cats.add'));
    const save = h('button', { type: 'button', className: 'btn btn-sm btn-primary', 'data-testid': 'fresh-cat-save' }, t('common.save'));
    save.addEventListener('click', async () => {
      for (const row of rows) if (!row.id) row.id = uniqueId(slug(row.label));
      save.disabled = true; say.textContent = '';
      try {
        const res = await api('/api/fresh/categories', { method: 'PUT', body: { categories: rows.map(({ id, label, halfLifeHours, keywords }) => ({ id, label: label.trim(), halfLifeHours, keywords })) } });
        changed = true; onOrder?.(res.catOrder);
        await paint(); notify(t('feed.cats.saved'));
      } catch (e) { say.textContent = e.message; } finally { save.disabled = false; }
    });
    draw();
    if (!editor.editable) return h('section', { 'data-section': 'categories' }, h('h3', {}, t('feed.cats.title')), h('p', { className: 'dlg-note' }, t('feed.cats.locked')));
    return h('section', { 'data-section': 'categories' }, h('h3', {}, t('feed.cats.title')), h('p', { className: 'dlg-note' }, t('feed.cats.hint')), list,
      h('div', { className: 'fr-s-add' }, add, save), say);
  }

  // Which English terms the cards keep as they are and which are translated. System One decides new ones; what you set here wins.
  function glossaryBlock(contentLanguage) {
    const out = h('div', { className: 'fr-s-gloss' }, h('p', { className: 'dlg-note' }, t('common.loading')));
    const box = h('details', { className: 'dlg-details', 'data-testid': 'fresh-glossary' }, h('summary', {}, t('feed.glossary.title')), out);
    const WHO = { seed: t('feed.glossary.who.seed'), jev: 'System One', owner: t('feed.glossary.who.owner') };
    let entries = [];
    const search = h('input', { type: 'search', className: 'input input-sm', placeholder: t('feed.glossary.search'), 'aria-label': t('feed.glossary.search'), autocomplete: 'off', spellcheck: 'false', 'data-testid': 'fresh-gloss-search' });
    const list = h('div', { className: 'fr-s-list' });
    const count = h('small', { className: 'fr-s-say' });
    async function put(e, body) {
      try {
        const next = await api(`/api/fresh/glossary/${encodeURIComponent(e.term)}`, { method: 'PUT', body });
        Object.assign(e, next); changed = true; draw();
      } catch (err) { notify(err.message); }
    }
    function rowOf(e) {
      const state = e.keep ? t('feed.glossary.state.keep') : `→ ${e.form}`;
      const toggle = h('button', { type: 'button', className: 'btn btn-sm', 'data-flip': e.term }, e.keep ? t('feed.glossary.translate') : t('feed.glossary.keep'));
      const li = h('div', { className: 'fr-s-src', 'data-term': e.term }, h('span', { className: 'fr-s-name' }, h('b', {}, e.term), h('small', {}, `${state} · ${WHO[e.source] ?? e.source}`)), toggle);
      toggle.addEventListener('click', () => {
        if (!e.keep) return put(e, { decision: 'keep' });
        if (e.form) return put(e, { decision: 'translate' });
        const form = h('input', { type: 'text', className: 'input input-sm', placeholder: t('feed.glossary.form', { language: contentLanguage }), 'aria-label': t('feed.glossary.formLabel', { language: contentLanguage, term: e.term }), maxlength: 40 });
        const ok = h('button', { type: 'button', className: 'btn btn-sm btn-primary', onClick: () => form.value.trim() && put(e, { decision: 'translate', form: form.value.trim() }) }, t('common.save'));
        form.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ok.click(); });
        li.replaceChildren(h('span', { className: 'fr-s-name' }, h('b', {}, e.term)), form, ok, h('button', { type: 'button', className: 'btn btn-sm', onClick: draw }, t('common.cancel')));
        form.focus();
      });
      return li;
    }
    function draw() {
      const needle = search.value.trim().toLowerCase();
      const hits = entries.filter((e) => !needle || e.term.includes(needle) || e.form?.includes(needle));
      list.replaceChildren(...hits.slice(0, 120).map(rowOf));
      count.textContent = `${t('feed.glossary.count', { n: hits.length, total: entries.length })}${hits.length > 120 ? ` ${t('feed.glossary.countTruncated')}` : ''}.`;
    }
    search.addEventListener('input', draw);
    box.addEventListener('toggle', async () => {
      if (!box.open || box.dataset.loaded) return;
      box.dataset.loaded = '1';
      try {
        entries = (await api('/api/fresh/glossary')).entries;
        out.replaceChildren(h('p', { className: 'dlg-note' }, t('feed.glossary.hint')), search, list, count);
        draw();
      } catch (err) { box.dataset.loaded = ''; out.replaceChildren(h('p', { className: 'dlg-note' }, err.message)); }
    });
    return box;
  }

  // "Fresh: N new stories ready" push: one notification after a complete gathering round. Saved at once; the other guards are explained.
  function notifyBlock(data) {
    const cfg = data.notify ?? {};
    const say = h('small', { className: 'fr-s-say', role: 'status' });
    const put = async (patch) => {
      try { const res = await api('/api/fresh/settings', { method: 'PUT', body: { notify: patch } }); changed = true; Object.assign(cfg, res.notify); say.textContent = t('common.saved'); }
      catch (e) { say.textContent = ''; notify(e.message); }
    };
    const on = h('input', { type: 'checkbox', className: 'toggle toggle-sm', 'aria-label': t('feed.notify.enable'), 'data-testid': 'fresh-notify-enabled' });
    on.checked = cfg.enabled !== false;
    on.addEventListener('change', () => put({ enabled: on.checked }));
    const pick = (label, key, options, testid) => {
      const sel = h('select', { className: 'select select-sm', 'aria-label': label, 'data-testid': testid }, options.map(([v, l]) => h('option', { value: String(v), selected: v === cfg[key] }, l)));
      if (!options.some(([v]) => v === cfg[key])) sel.prepend(h('option', { value: String(cfg[key]), selected: true }, String(cfg[key])));
      sel.addEventListener('change', () => put({ [key]: Number(sel.value) }));
      return h('label', { className: 'fr-s-row' }, h('span', {}, label), sel);
    };
    const quiet = h('input', { type: 'checkbox', className: 'toggle toggle-sm', 'aria-label': t('feed.notify.quiet'), 'data-testid': 'fresh-notify-quiet' });
    quiet.checked = Boolean(cfg.quiet?.on);
    const from = h('input', { type: 'time', className: 'input input-sm', value: cfg.quiet?.from ?? '23:00', 'aria-label': t('feed.notify.quietFrom'), 'data-testid': 'fresh-notify-from' });
    const to = h('input', { type: 'time', className: 'input input-sm', value: cfg.quiet?.to ?? '07:00', 'aria-label': t('feed.notify.quietTo'), 'data-testid': 'fresh-notify-to' });
    const times = h('div', { className: 'fr-s-quiet' }, from, h('span', {}, t('feed.notify.quietUntil')), to);
    const sync = () => { times.hidden = !quiet.checked; };
    sync();
    quiet.addEventListener('change', () => { sync(); put({ quiet: { on: quiet.checked } }); });
    from.addEventListener('change', () => from.value && put({ quiet: { from: from.value } }));
    to.addEventListener('change', () => to.value && put({ quiet: { to: to.value } }));
    const state = cfg.subscribed
      ? `${t('feed.notify.pending', { n: cfg.pending ?? 0 })}${cfg.held ? ` ${t('feed.notify.held')}` : ''}.`
      : t('feed.notify.none');
    return h('section', { 'data-section': 'notify', 'data-testid': 'fresh-notify' }, h('h3', {}, t('feed.notify.title')),
      h('label', { className: 'fr-s-row' }, h('span', {}, t('feed.notify.ready')), on),
      pick(t('feed.notify.minNew'), 'minNew', [[3, '3'], [5, '5'], [8, '8'], [10, '10'], [20, '20']], 'fresh-notify-min'),
      pick(t('feed.notify.minInterval'), 'minIntervalH', [[1, t('feed.hours.1')], [3, t('feed.hours.3')], [6, t('feed.hours.6')], [12, t('feed.hours.12')]], 'fresh-notify-interval'),
      h('label', { className: 'fr-s-row' }, h('span', {}, t('feed.notify.quietTitle', { timezone: data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone })), quiet), times,
      h('p', { className: 'dlg-note' }, t('feed.notify.hint')),
      h('p', { className: 'dlg-note', 'data-testid': 'fresh-notify-state' }, state), say);
  }

  async function paint() {
    let data;
    let editor;
    try { [data, editor] = await Promise.all([api('/api/fresh/settings'), api('/api/fresh/categories')]); } catch (err) { body.replaceChildren(h('p', { className: 'dlg-note' }, err.message)); return; }

    // -- general
    const enabled = h('input', { type: 'checkbox', className: 'toggle toggle-sm', 'data-testid': 'fresh-enabled' });
    enabled.checked = data.enabled;
    const interval = h('select', { className: 'select select-sm', 'aria-label': t('feed.interval.label') }, INTERVALS.map(([v, l]) => h('option', { value: String(v), selected: v === data.intervalMin }, l)));
    const save = () => api('/api/fresh/settings', { method: 'PUT', body: { enabled: enabled.checked, intervalMin: Number(interval.value) } }).then(() => { changed = true; }).catch((e) => notify(e.message));
    enabled.addEventListener('change', save);
    interval.addEventListener('change', save);
    const general = h('section', {}, h('h3', {}, t('feed.general.title')),
      h('label', { className: 'fr-s-row' }, h('span', {}, t('feed.auto.title')), enabled),
      h('label', { className: 'fr-s-row' }, h('span', {}, t('feed.auto.interval')), interval));

    // -- sources, one group per category; Bluesky, Steam and X have their own section
    const sourceRow = (s) => {
      const on = h('input', { type: 'checkbox', className: 'toggle toggle-sm', 'aria-label': t('feed.source.enable', { name: s.name }) });
      on.checked = s.on;
      on.addEventListener('change', () => api(`/api/fresh/sources/${s.id}`, { method: 'PATCH', body: { on: on.checked } }).then(() => { changed = true; }).catch((e) => notify(e.message)));
      const status = s.ok === false ? h('small', { className: 'fr-s-bad', title: s.error }, t('feed.source.failed', { n: s.fails })) : s.ok ? h('small', {}, t('feed.items', { count: s.count })) : h('small', {}, t('feed.source.unchecked'));
      const remove = s.custom ? h('button', { type: 'button', className: 'ibtn', 'aria-label': t('feed.source.remove', { name: s.name }), onClick: async () => { await api(`/api/fresh/sources/${s.id}`, { method: 'DELETE' }).catch((e) => notify(e.message)); changed = true; paint(); } }, icon('trash', 16)) : null;
      return h('div', { className: 'fr-s-src', 'data-id': s.id }, h('span', { className: 'fr-s-name' }, h('b', {}, s.name), h('small', {}, s.kind)), status, on, remove);
    };
    const real = data.sources.filter((s) => !s.virtual);
    const groups = Object.entries(data.categories).map(([cid, label]) => {
      const list = real.filter((s) => s.cat === cid);
      return list.length ? h('div', { className: 'fr-s-group', 'data-cat': cid }, h('h4', {}, t('feed.source.group', { label, n: list.length })), h('div', { className: 'fr-s-list' }, list.map(sourceRow))) : null;
    });
    const orphans = real.filter((s) => !data.categories[s.cat]);
    if (orphans.length) groups.push(h('div', { className: 'fr-s-group', 'data-cat': '' }, h('h4', {}, t('feed.source.group', { label: t('feed.cats.other'), n: orphans.length })), h('div', { className: 'fr-s-list' }, orphans.map(sourceRow))));
    const url = h('input', { type: 'text', className: 'input input-sm', placeholder: t('feed.source.addPlaceholder'), 'aria-label': t('feed.source.addLabel'), 'data-testid': 'fresh-add-url', autocomplete: 'off', spellcheck: 'false' });
    const cat = h('select', { className: 'select select-sm', 'aria-label': t('feed.source.category') }, Object.entries(data.categories).map(([v, l]) => h('option', { value: v, selected: v === 'ai' }, l)));
    const msg = h('small', { className: 'fr-s-msg', role: 'status' });
    const add = h('button', { type: 'button', className: 'btn btn-sm btn-primary', 'data-testid': 'fresh-add' }, t('feed.source.add'));
    add.addEventListener('click', async () => {
      if (!url.value.trim()) return;
      add.disabled = true; msg.textContent = t('feed.source.finding');
      try { await api('/api/fresh/sources', { method: 'POST', body: { url: url.value.trim(), cat: cat.value } }); changed = true; await paint(); notify(t('feed.source.added')); }
      catch (e) { msg.textContent = e.message; } finally { add.disabled = false; }
    });
    const sources = h('section', { 'data-section': 'sources' }, h('h3', {}, t('feed.source.title', { n: real.length })), groups, h('div', { className: 'fr-s-add' }, url, cat, add), msg);

    // -- Bluesky, Steam, X
    const social = h('section', { 'data-section': 'social' }, h('h3', {}, t('feed.source.groupSocial')),
      h('div', { className: 'fr-s-list' }, data.sources.filter((s) => s.virtual && s.id !== 'x').map(sourceRow)), xBlock(data));

    // -- taste
    const topics = data.topics.length
      ? h('div', { className: 'fr-s-topics' }, data.topics.map((topic) => h('span', { className: `fr-s-topic ${topic.weight < 0 ? 'less' : 'more'}` }, `${topic.weight < 0 ? t('feed.taste.less') : t('feed.taste.more')} · ${topic.token}`,
        h('button', { type: 'button', 'aria-label': t('feed.taste.forget', { token: topic.token }), onClick: async () => { await api(`/api/fresh/topics/${encodeURIComponent(topic.token)}`, { method: 'DELETE' }).catch(() => {}); changed = true; paint(); } }, icon('x', 12)))))
      : h('p', { className: 'dlg-note' }, t('feed.taste.empty'));
    const taste = h('section', {}, h('h3', {}, t('feed.taste.title')), topics);

    // -- hermes worker
    const token = h('button', { type: 'button', className: 'btn btn-sm', 'data-testid': 'fresh-token' }, t('feed.ingest.copy'));
    token.addEventListener('click', async () => { try { const { token: secret } = await api('/api/fresh/ingest-token'); notify((await copyText(secret)) ? t('feed.ingest.copied') : t('common.copyFailed')); } catch (e) { notify(e.message); } });
    const worker = h('section', {}, h('h3', {}, t('feed.ingest.title')),
      h('p', { className: 'dlg-note' }, t('feed.ingest.hintBefore'), h('code', {}, `${location.origin}/api/fresh/ingest`), t('feed.ingest.hintAfter')),
      token);
    body.replaceChildren(general, notifyBlock(data), orderBlock(data), categoriesBlock(editor), sources, social, taste, glossaryBlock(data.contentLanguage ?? ''), worker, status());
  }
  paint();
}
