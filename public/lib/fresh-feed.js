// "Fresh": the home timeline of the Feed style. Short, readable cards about what is new (PC gaming, console, PC building, AI,
// security), gathered and ranked by the server ("For you" or newest first); each card can be read in place, saved, turned into a chat, or saved.
// The list is cached on the phone, so the app opens on what you saw last while the news is checked in the background;
// it loads further pages as you scroll, and a small pill says when something newer is waiting.
import { h } from './dom.js';
import { icon } from './icons.js';
import { api, fetchRaw, toApiError } from './api.js';
import { openMenu } from './menu.js';
import { notify } from './ui.js';
import { copyText, copyWithFeedback } from './clipboard.js';
import { signal, createSeenTracker } from './fresh-signals.js';
import { t } from './i18n.js';
import { fmtAgo, fmtCompact, agentLabel } from './format.js';
import { state } from './state.js';

const CACHE_KEY = 'hermes.fresh.v2'; // v1 held cards with the old categories (ai, dev, game): never shown again
const MODE_KEY = 'hermes.fresh.mode';
const PAGE = 10;
const POLL_MS = 5 * 60_000;
const STALE_MS = 2 * 60_000;
const CHIPS = [['', t('feed.chip.all')], ['pcgaming', 'PC Gaming'], ['console', 'Console'], ['pcbuild', 'PC Building'], ['ai', 'AI'], ['security', t('feed.chip.security')], ['saved', t('feed.chip.saved')]];
const ORDER_KEY = 'hermes.fresh.catorder'; // the chip order, cached so the bar paints right on the first frame (the server copy wins)
const DEFAULT_ORDER = CHIPS.slice(1).map(([key]) => key);
const MODES = [['foryou', t('feed.mode.foryou')], ['latest', t('feed.mode.latest')]];

export function agoShort(ts) {
  // Cards and the last run carry milliseconds; fmtAgo takes epoch seconds.
  return fmtAgo(ts == null ? ts : ts / 1000, { compact: true });
}
// 1200 -> "1.2K", 15400 -> "15K", 2300000 -> "2.3M" (stars of a GitHub repo)
export function starsShort(n) {
  return n >= 1000 ? fmtCompact(n) : String(Math.round(n));
}
const letter = (name) => (String(name).trim()[0] ?? '?').toUpperCase();

function readMode() {
  try { return localStorage.getItem(MODE_KEY) === 'latest' ? 'latest' : 'foryou'; } catch { return 'foryou'; }
}
function readCache() {
  try { localStorage.removeItem('hermes.fresh.v1'); } catch { /* nothing to clean */ }
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY)); return c && Array.isArray(c.items) ? c : null; } catch { return null; }
}
function writeCache(items, newest) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), newest, items: items.slice(0, 20) })); } catch { /* storage full or blocked: only the instant start is lost */ }
}

// ids the user put in order first, unknown / repeated ones dropped, the rest in default order ("All" is not part of it)
export function normalizeOrder(list) {
  const first = [...new Set(Array.isArray(list) ? list : [])].filter((id) => DEFAULT_ORDER.includes(id));
  return [...first, ...DEFAULT_ORDER.filter((id) => !first.includes(id))];
}
function readOrder() {
  try { return normalizeOrder(JSON.parse(localStorage.getItem(ORDER_KEY))); } catch { return DEFAULT_ORDER; }
}
function writeOrder(order) {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(order)); } catch { /* only the instant first paint is lost */ }
}

// scroller: the element that scrolls (for the infinite-scroll trigger); ask(item): opens a chat about the story.
export function createFresh({ scroller, ask }) {
  const st = { cat: '', mode: readMode(), items: [], next: '', loading: false, ended: false, error: '', contentLang: '', contentLanguage: '', newest: 0, etag: '', lastCheck: 0, pending: 0, ready: false };
  let generation = 0; // a reply for an older filter / reload is ignored

  const chipOf = new Map(CHIPS.map(([key, label]) => [key, h('button', { type: 'button', className: 'fr-chip', 'data-cat': key, 'aria-pressed': 'false', onClick: () => setCat(key) }, label)]));
  const chips = [...chipOf.values()];
  const chipBar = h('div', { className: 'fr-chips', role: 'tablist', 'aria-label': t('feed.category') }, chipOf.get(''), ...readOrder().map((key) => chipOf.get(key)));
  // Puts the chips in this order ("All" stays first); the elements are moved, so the selected state and listeners stay.
  function setOrder(order, { remember = true } = {}) {
    const next = normalizeOrder(order);
    if (next.join() !== [...chipBar.children].slice(1).map((c) => c.dataset.cat).join()) chipBar.append(...next.map((key) => chipOf.get(key)));
    if (remember) writeOrder(next);
  }
  const refreshBtn = h('button', { type: 'button', className: 'ibtn fr-tool', 'aria-label': t('feed.refresh'), title: t('feed.refresh'), 'data-testid': 'fresh-refresh', onClick: () => refresh({ announce: true, toTop: true }) }, icon('refresh', 18));
  const sourcesBtn = h('button', { type: 'button', className: 'ibtn fr-tool', 'aria-label': t('feed.settings.title'), title: t('feed.settings.title'), 'data-testid': 'fresh-sources', onClick: () => import('./fresh-sources.js').then(({ openFreshSources }) => openFreshSources({ onChange: () => reload(), onOrder: (order) => setOrder(order) })) }, icon('sliders', 18));
  const modes = MODES.map(([key, label]) => h('button', { type: 'button', className: 'fr-mode-btn', 'data-mode': key, 'aria-pressed': 'false', onClick: () => setMode(key) }, label));
  const modeRow = h('div', { className: 'fr-mode', role: 'group', 'aria-label': t('feed.order.label') }, modes);
  const bar = h('div', { className: 'fr-bar' }, chipBar, h('span', { className: 'fr-tools' }, refreshBtn, sourcesBtn));
  const pill = h('button', { type: 'button', className: 'fr-pill', hidden: true, 'data-testid': 'fresh-pill', onClick: () => showNew() });
  const list = h('div', { className: 'fr-list', 'data-testid': 'fresh-list' });
  const foot = h('div', { className: 'fr-foot', 'aria-live': 'polite' });
  const sentinel = h('div', { className: 'fr-sentinel', 'aria-hidden': 'true' });
  const el = h('section', { className: 'fr', 'aria-label': t('feed.latest'), 'data-testid': 'fresh' }, bar, modeRow, pill, list, foot, sentinel);

  const paintChips = () => {
    chips.forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.cat === st.cat)));
    modes.forEach((m) => m.setAttribute('aria-pressed', String(m.dataset.mode === st.mode)));
    modeRow.hidden = st.cat === 'saved'; // saved stories are in the order you saved them
  };
  const seen = createSeenTracker({ root: scroller, onSeen: (id) => { const it = st.items.find((i) => i.id === id); if (it) it.seen = true; } });

  // ---------- cards ----------
  function card(item) {
    const more = h('button', { type: 'button', className: 'ibtn fr-more', 'aria-label': t('feed.card.more'), 'aria-haspopup': 'menu' }, icon('more-horizontal', 20));
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      openMenu(more, [
        { label: t('feed.card.copyLink'), icon: 'copy', action: async () => notify((await copyText(item.url)) ? t('feed.card.linkCopied') : t('common.copyFailed')) },
      ], t('feed.card.actions'));
    });
    const saveBtn = h('button', { type: 'button', className: 'fr-act', 'aria-pressed': String(item.saved), 'aria-label': item.saved ? t('feed.card.unsave') : t('feed.card.save'), title: t('feed.card.save'), 'data-act': 'save' }, icon('bookmark', 20));
    saveBtn.addEventListener('click', () => toggleSave(item, saveBtn));
    const askBtn = h('button', { type: 'button', className: 'btn btn-sm btn-primary fr-ask', 'data-act': 'ask', 'data-testid': 'fresh-ask' }, icon('message-circle', 16), t('feed.reader.ask', { agent: agentLabel(state.agent) }));
    askBtn.addEventListener('click', () => { markRead(item, article); signal(item.id, 'ask'); ask(item); });
    const readBtn = h('button', { type: 'button', className: 'btn btn-sm fr-read', 'data-act': 'read' }, icon('book-open', 16), t('feed.card.read'));
    readBtn.addEventListener('click', () => open(item));
    const out = h('a', { className: 'fr-act', href: item.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': t('feed.card.openSource'), title: t('feed.card.openSource'), 'data-act': 'source' }, icon('external-link', 20));
    out.addEventListener('click', () => { markRead(item, article); signal(item.id, 'open'); });

    const media = item.image
      ? h('button', { type: 'button', className: 'fr-media', 'aria-label': t('feed.card.readTitle', { title: item.title }) }, h('img', { src: item.image, alt: '', loading: 'lazy', decoding: 'async' }))
      : null;
    media?.addEventListener('click', () => open(item));
    const heading = h('h3', { className: 'fr-title' }, h('button', { type: 'button', className: 'fr-title-btn', onClick: () => open(item) }, item.title));
    const corroborated = item.outlets > 1 ? h('p', { className: 'fr-outlets' }, t('feed.card.outlets', { n: item.outlets }) + (item.also.length ? `: ${item.also.join(', ')}` : '')) : null;

    const sale = item.kind === 'steam-sale';
    const tags = [
      sale ? h('span', { className: 'fr-tag', 'data-tag': 'sale' }, t('feed.card.steamSale')) : null,
      item.lang && item.lang === st.contentLang ? h('span', { className: 'fr-buzz', 'data-tag': 'lang' }, t('feed.card.fromX', { language: st.contentLanguage })) : null,
      ...(item.buzz ?? []).map((text) => h('span', { className: 'fr-buzz', 'data-tag': 'buzz' }, text)),
    ].filter(Boolean);
    const repo = item.gh ? repoBlock(item.gh) : null;
    const article = h('article', { className: `fr-card${item.image ? '' : ' no-media'}${item.read ? ' is-read' : ''}${sale ? ' is-sale' : ''}`, 'data-id': item.id, 'data-cat': item.cat, 'data-testid': 'fresh-card' },
      h('header', { className: 'fr-head' },
        h('span', { className: 'fr-src', 'aria-hidden': 'true' }, letter(item.sourceName)),
        h('span', { className: 'fr-who' }, h('b', {}, item.sourceName), h('span', { className: 'fr-dot' }, '•'), h('time', {}, agoShort(item.ts)), h('span', { className: 'fr-cat' }, item.catLabel)),
        more),
      media,
      h('div', { className: 'fr-body' },
        tags.length ? h('div', { className: 'fr-tags' }, tags) : null,
        heading,
        item.summary ? h('p', { className: 'fr-sum' }, item.summary) : null,
        item.why ? h('p', { className: 'fr-why' }, h('b', {}, t('feed.reader.why')), ' ', item.why) : null,
        repo,
        corroborated),
      h('footer', { className: 'fr-actions' }, askBtn, readBtn, h('span', { className: 'fr-spacer' }), saveBtn, out));
    seen.track(article);
    return article;
  }

  // GitHub repo: stars and what they gained, language, license, and the command to try it (copyable, scrolls sideways inside its own box).
  function repoBlock(gh) {
    const gain = gh.d24 >= 50 ? t('feed.repo.gain24h', { n: starsShort(gh.d24) }) : gh.d7 > 0 ? t('feed.repo.gainWeek', { n: starsShort(gh.d7) }) : '';
    const facts = [h('span', { className: 'fr-gh-stars', title: t('feed.repo.stars', { n: gh.stars.toLocaleString('en-US') }) }, `★ ${starsShort(gh.stars)}`), gain ? h('span', { className: 'fr-gh-gain' }, gain) : null, gh.lang ? h('span', {}, gh.lang) : null, gh.license ? h('span', {}, gh.license) : null].filter(Boolean);
    const out = [h('div', { className: 'fr-gh', 'data-testid': 'fresh-gh' }, facts)];
    if (gh.coba) {
      const btn = h('button', { type: 'button', className: 'fr-try-copy', 'aria-label': t('feed.repo.copyCommand'), title: t('feed.repo.copyCommand'), 'data-testid': 'fresh-copy-cmd' }, icon('copy', 16));
      btn.addEventListener('click', () => copyWithFeedback(gh.coba, (ok) => {
        if (ok === null) { btn.replaceChildren(icon('copy', 16)); btn.setAttribute('aria-label', t('feed.repo.copyCommand')); return; }
        btn.replaceChildren(icon(ok ? 'check' : 'x', 16)); btn.setAttribute('aria-label', ok ? t('common.copied') : t('common.copyFailed'));
        if (!ok) notify(t('common.copyFailed'));
      }));
      out.push(h('div', { className: 'fr-try', 'data-testid': 'fresh-try' }, h('span', { className: 'fr-try-l' }, t('feed.repo.try')), h('code', { className: 'fr-try-cmd', tabIndex: 0 }, gh.coba), btn));
    }
    return h('div', { className: 'fr-repo' }, out);
  }

  function markRead(item, node) {
    if (!item.read) { item.read = true; api(`/api/fresh/${item.id}/read`, { method: 'POST' }).catch(() => {}); }
    node?.classList.add('is-read');
  }
  function open(item) {
    markRead(item, list.querySelector(`[data-id="${item.id}"]`));
    signal(item.id, 'open');
    import('./fresh-reader.js').then(({ openReader }) => openReader({ id: item.id, item, ask, onSave: (saved) => { item.saved = saved; syncSave(item); } }));
  }
  function syncSave(item) {
    const btn = list.querySelector(`[data-id="${item.id}"] [data-act="save"]`);
    if (btn) { btn.setAttribute('aria-pressed', String(item.saved)); btn.setAttribute('aria-label', item.saved ? t('feed.card.unsave') : t('feed.card.save')); }
  }
  async function toggleSave(item, btn) {
    item.saved = !item.saved;
    syncSave(item);
    notify(item.saved ? t('feed.card.saved') : t('feed.card.unsaved'));
    if (item.saved) signal(item.id, 'save');
    try { await api(`/api/fresh/${item.id}/${item.saved ? 'save' : 'unsave'}`, { method: 'POST' }); }
    catch { item.saved = !item.saved; syncSave(item); notify(t('feed.reader.saveFailed')); }
    if (st.cat === 'saved' && !item.saved) list.querySelector(`[data-id="${item.id}"]`)?.remove();
  }
  // ---------- list state ----------
  function empty() {
    foot.replaceChildren();
    if (st.loading) return;
    if (st.error && !st.items.length) {
      foot.replaceChildren(h('div', { className: 'status status-error', role: 'alert' }, h('p', {}, st.error), h('button', { type: 'button', className: 'btn btn-sm', onClick: () => reload() }, t('common.retry'))));
    } else if (!st.items.length) {
      foot.replaceChildren(st.cat === 'saved'
        ? h('div', { className: 'fr-empty' }, h('b', {}, t('feed.empty.saved.title')), h('p', {}, t('feed.empty.saved.hint')))
        : h('div', { className: 'fr-empty' }, h('b', {}, t('feed.empty.title')), h('p', {}, t('feed.empty.hint'))));
    } else if (st.ended) {
      foot.replaceChildren(h('p', { className: 'fr-end' }, t('feed.end')));
    }
  }
  function skeleton() {
    foot.replaceChildren(...Array.from({ length: 2 }, () => h('div', { className: 'fr-skel', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))));
  }
  function append(items) {
    list.append(...items.map(card));
  }

  async function fetchPage({ cursor = '', conditional = false } = {}) {
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (st.cat === 'saved') params.set('saved', '1'); else { params.set('mode', st.mode); if (st.cat) params.set('cat', st.cat); }
    if (cursor) params.set('cursor', cursor);
    const headers = conditional && st.etag && !cursor ? { 'If-None-Match': st.etag } : {};
    const res = await fetchRaw(`/api/fresh?${params}`, { headers });
    if (res.status === 304) return null;
    if (!res.ok) throw await toApiError(res);
    const data = await res.json();
    if (data.contentLang) { st.contentLang = data.contentLang; st.contentLanguage = data.contentLanguage ?? ''; }
    return { data, etag: res.headers.get('etag') ?? '' };
  }

  // Replaces the list with the first page of the current filter.
  async function reload({ keepScroll = false } = {}) {
    const mine = ++generation;
    st.loading = true;
    st.error = '';
    if (!st.items.length) skeleton();
    try {
      const got = await fetchPage({ conditional: st.items.length > 0 });
      if (mine !== generation) return;
      if (got) {
        const known = new Map(st.items.map((i) => [i.id, i]));
        st.items = got.data.items.map((i) => ({ ...i, read: known.get(i.id)?.read }));
        st.next = got.data.next;
        st.newest = got.data.newest;
        st.etag = got.etag;
        st.ended = !got.data.next;
        if (got.data.catOrder) setOrder(got.data.catOrder);
        seen.reset();
        list.replaceChildren();
        append(st.items);
        if (!keepScroll) scroller.scrollTop = Math.min(scroller.scrollTop, el.offsetTop);
        if (!st.cat && st.mode === 'foryou') writeCache(st.items, st.newest);
      }
      st.pending = 0;
      pill.hidden = true;
      st.lastCheck = Date.now();
    } catch (err) {
      if (mine === generation) st.error = err.message || t('feed.error.load');
    } finally {
      if (mine === generation) { st.loading = false; st.ready = true; empty(); more(); }
    }
  }

  async function loadMore() {
    if (st.loading || st.ended || !st.next) return;
    const mine = generation;
    st.loading = true;
    foot.replaceChildren(h('div', { className: 'fr-spin', role: 'status', 'aria-label': t('common.loading') }, icon('refresh', 18)));
    try {
      const got = await fetchPage({ cursor: st.next });
      if (mine !== generation || !got) return;
      const have = new Set(st.items.map((i) => i.id));
      const fresh = got.data.items.filter((i) => !have.has(i.id));
      st.items.push(...fresh);
      st.next = got.data.next;
      st.ended = !got.data.next;
      append(fresh);
    } catch (err) {
      st.error = err.message;
      notify(t('feed.error.loadMore'));
    } finally {
      if (mine === generation) { st.loading = false; empty(); more(); }
    }
  }

  // Next page as soon as the end of the list comes within reach.
  const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) loadMore(); }, { root: scroller, rootMargin: '700px 0px' });
  observer.observe(sentinel);
  // The sentinel stays "visible" when a page is too short to scroll: look again after every page.
  function more() { observer.unobserve(sentinel); observer.observe(sentinel); }

  async function setCat(cat) {
    if (cat === st.cat) return;
    st.cat = cat;
    st.items = []; st.next = ''; st.ended = false; st.etag = '';
    seen.reset();
    list.replaceChildren();
    paintChips();
    reload();
  }
  function setMode(mode) {
    if (mode === st.mode) return;
    st.mode = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* the choice just is not remembered */ }
    st.items = []; st.next = ''; st.ended = false; st.etag = '';
    seen.reset();
    list.replaceChildren();
    paintChips();
    scroller.scrollTop = Math.min(scroller.scrollTop, el.offsetTop);
    reload();
  }

  // ---------- news ----------
  function showPill(count) {
    st.pending = count;
    pill.textContent = t('feed.newStories', { n: count });
    pill.prepend(icon('chevron-down', 14));
    pill.hidden = count < 1;
  }
  function showNew() {
    pill.hidden = true;
    scroller.scrollTo({ top: Math.max(0, el.offsetTop - 4), behavior: 'smooth' });
    reload({ keepScroll: true });
  }
  async function poll() {
    if (!st.ready || document.visibilityState !== 'visible') return;
    st.lastCheck = Date.now();
    try {
      const res = await api(`/api/fresh/poll?since=${st.newest || 0}`);
      if (res.count > 0 && st.cat !== 'saved') showPill(res.count);
    } catch { /* checked again next time */ }
  }
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - st.lastCheck > STALE_MS) poll(); });

  // Wakes the server's gatherer (it answers at once and keeps working in the background) and shows the newest ranking from
  // the top. Resolves with how many cards are new since the last visit.
  async function refresh({ announce = false, toTop = false } = {}) {
    refreshBtn.classList.add('is-spinning');
    try {
      const result = await api('/api/fresh/refresh', { method: 'POST' });
      await reload({ keepScroll: !toTop });
      const count = result.newCount ?? 0;
      if (count > 0) notify(t('feed.newStoriesDone', { n: count }));
      else if (announce) {
        const last = result.lastRunAt ? ` ${t('feed.lastChecked', { time: agoShort(result.lastRunAt) })}` : '';
        notify(result.running ? t('feed.nothingNew.running') : `${t('feed.nothingNew')}${last}`);
      }
      return count;
    } catch (err) {
      notify(err.message || t('feed.error.refresh'));
      return 0;
    } finally { refreshBtn.classList.remove('is-spinning'); }
  }

  // ---------- start ----------
  function start() {
    paintChips();
    const cached = readCache();
    if (cached?.items.length && !st.items.length) {
      st.items = cached.items; st.newest = cached.newest ?? 0;
      append(st.items);
      el.classList.add('from-cache');
    }
    // The news check waits until the screen is idle: the chat list and the composer's own requests go first.
    const check = () => reload({ keepScroll: true }).then(() => el.classList.remove('from-cache'));
    if (window.requestIdleCallback) requestIdleCallback(check, { timeout: 1200 }); else setTimeout(check, 300);
  }
  // The Home button: back to "All" (the For you / Latest choice stays) and the newest ranking, like pull to refresh.
  function home() {
    if (st.cat !== '') {
      st.cat = '';
      st.items = []; st.next = ''; st.ended = false; st.etag = '';
      seen.reset();
      list.replaceChildren();
      paintChips();
    }
    return refresh({ announce: true, toTop: true });
  }
  return { el, start, refresh, reload, home, setOrder };
}
