// "Feed" interface style, the app around the chat, laid out like Instagram: on a phone a top bar, a row of stories, posts
// (one per chat) and an icon tab bar; on a desktop a left navigation column, the feed in the middle and a small column
// on the right. Chats open with the usual `session:select` event, so everything inside a chat is the normal app.
import { h, $ } from './dom.js';
import { icon } from './icons.js';
import { api, agentPath } from './api.js';
import { state, emit, on, runningSessionIds, readRoute } from './state.js';
import { navigate } from './back-nav.js';
import { sessionTitle } from './session-row.js';
import { copyText } from './clipboard.js';
import { notify } from './ui.js';
import { createFresh } from './fresh-feed.js';
import { loadSessions } from './sessions.js';
import { t } from './i18n.js';
import { APP_NAME } from './brand.js';
import { fmtAgo } from './format.js';

const root = document.documentElement;
const mobile = matchMedia('(max-width: 899px)');
const STORIES = 30; // every chat is a circle (the newest ones first); the older ones sit behind "See all"
const COVER_DRAW = 12; // only the newest circles get a picture drawn for them

let view = 'chat';
let home;
let scroller;
let main;
let storiesHost;
let fresh;
let freshStarted = false;
let aside = document.createElement('aside');
let homeScroll = 0;
let storiesScroll = 0;

const ago = (epochSec) => fmtAgo(epochSec, { compact: true });

function plainSnippet(markdown, max = 220) {
  const lines = String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split('\n')
    .filter((l) => !/^\s*#{1,6}\s/.test(l) && !/^\s*\|/.test(l))
    .map((l) => l.replace(/^[\s>*+\-]+|[*_`]/g, '').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 3);
  const text = lines.slice(0, 2).join(' ');
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// ---- cover pictures: drawn once per chat by the server (free image model), one at a time ----
const covers = { enabled: true, ids: new Set(), loaded: false };
const coverQueue = [];
let drawing = 0;
const DRAW_PARALLEL = 3;
const coverUrl = (id) => `${agentPath(state.agent)}/sessions/${encodeURIComponent(id)}/cover`;
async function loadCovers() {
  const agent = state.agent;
  if (!agent) return;
  try {
    const res = await api(`${agentPath(agent)}/covers`);
    if (agent !== state.agent) return; // answer for an agent that was only a start-up guess
    covers.enabled = res.enabled !== false;
    covers.ids = new Set(res.ids ?? []);
  } catch {
    if (agent !== state.agent) return;
    covers.ids = new Set(); // a failed request is not "covers are off": only the server's own answer turns them off
  }
  covers.loaded = true;
}
function showCover(post, id) {
  const img = post.querySelector('.fh-cover');
  const media = post.querySelector('.fh-media');
  if (!img || !media) return;
  img.onload = () => { media.classList.add('has-cover'); media.classList.remove('is-making'); };
  img.onerror = () => media.classList.remove('is-making');
  img.src = `${coverUrl(id)}?v=${covers.ids.size}`;
}
const coverPending = new Set();
function wantCover(id, post) {
  if (!covers.enabled) return;
  if (covers.ids.has(id)) { if (post) showCover(post, id); return; }
  if (coverPending.has(id)) { if (post) post.querySelector('.fh-media')?.classList.add('is-making'); return; }
  coverPending.add(id);
  coverQueue.push([id, post]);
  drawNext();
}
async function drawNext() {
  while (drawing < DRAW_PARALLEL && coverQueue.length) {
    const [id, post] = coverQueue.shift();
    drawing += 1;
    const media = post?.querySelector('.fh-media');
    media?.classList.add('is-making');
    api(coverUrl(id), { method: 'POST' })
      .then((res) => {
        if (!res.ok) return;
        covers.ids.add(id);
        const live = document.querySelector(`.fh-post[data-id="${CSS.escape(id)}"]`);
        if (live) showCover(live, id);
        paintThumbs();
      })
      .catch(() => { /* the letter / text tile stays */ })
      .finally(() => { media?.classList.remove('is-making'); coverPending.delete(id); drawing -= 1; drawNext(); });
  }
}
// Thumbnails elsewhere (right column) follow when a cover appears.
function paintThumbs() {
  for (const el of document.querySelectorAll('.fh-mini[data-id], .fh-story[data-id]')) {
    const id = el.dataset.id;
    const av = el.querySelector('.fh-av, .fh-face');
    if (id && av && covers.ids.has(id) && !av.querySelector('img')) av.replaceChildren(h('img', { src: `${coverUrl(id)}?v=${covers.ids.size}`, alt: '', loading: 'lazy' }));
  }
}

const open = (id) => emit('session:select', id);
const initial = (text) => (String(text ?? '').trim()[0] ?? 'a').toUpperCase();
// Your own initial on the tab bar: empty until the account has arrived, so it never flips from a guessed letter.
const me0 = () => (state.me ? initial(state.me.username) : '');

// Which chats you already looked at (in the story viewer) and when: a circle keeps its coloured ring until the chat has
// something newer than what you saw.
const SEEN_KEY = 'hermes.storiesSeen';
const seenAll = () => { try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; } catch { return {}; } };
const seenAt = (id) => seenAll()[`${state.agent}:${id}`] ?? 0;
function markSeen(id) {
  const stamp = state.sessions.find((s) => s.id === id)?.last_active ?? Date.now() / 1000;
  try {
    const all = seenAll();
    all[`${state.agent}:${id}`] = stamp;
    const keys = Object.keys(all);
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete all[k];
    localStorage.setItem(SEEN_KEY, JSON.stringify(all));
  } catch { /* the ring simply stays coloured */ }
}

// First question, newest reply and newest question of a chat, worked out by the server (the phone gets a few hundred bytes
// instead of dozens of tool messages). Asked once per chat at a time.
const previewing = new Map();
function preview(id, full = false) {
  const key = `${state.agent}:${id}:${full}`;
  if (!previewing.has(key)) {
    previewing.set(key, api(`${agentPath(state.agent)}/sessions/${encodeURIComponent(id)}/preview${full ? '?full=1' : ''}`)
      .catch(() => ({ first: '', reply: '', ask: '' }))
      .finally(() => setTimeout(() => previewing.delete(key), 5000)));
  }
  return previewing.get(key);
}

// Latest reply of a chat for the story viewer (not kept: the viewer always shows what is there now).
async function latestReply(id) {
  const { reply, ask } = await preview(id, true);
  return { text: reply, ask: plainSnippet(ask, 400), cover: covers.ids.has(id) ? `${coverUrl(id)}?s=thumb&v=${covers.ids.size}` : null };
}

function story({ label, id = null, running = false, isNew = false, fresh = false, glyph = '', onClick }) {
  const face = h('span', { className: 'fh-face' }, isNew ? icon('square-plus', 26) : glyph ? icon(glyph, 26) : covers.ids.has(id) ? h('img', { src: `${coverUrl(id)}?s=thumb&v=${covers.ids.size}`, alt: '', loading: 'lazy', decoding: 'async' }) : initial(label));
  const ring = h('span', { className: 'fh-ring' }, face);
  const item = h('button', { type: 'button', className: `fh-story${running ? ' is-running' : ''}${isNew ? ' is-new' : ''}${fresh ? ' is-fresh' : ''}`, 'data-id': id ?? '', title: label }, ring, h('span', { className: 'fh-story-label' }, label));
  item.addEventListener('click', onClick ?? (() => open(id)));
  return item;
}

// Placeholder circle while the chat list is on its way (same pulse as the timeline's placeholder cards).
const storySkeleton = () => h('div', { className: 'fh-story fh-story-skel', 'aria-hidden': 'true' }, h('span', { className: 'fh-ring' }, h('span', { className: 'fh-face' })), h('span', { className: 'fh-story-label' }));
let listed = false; // the chat list has arrived (or failed): until then the row shows placeholders

// Several things ask for a redraw at start-up (list, covers, size): they are folded into one per frame.
let renderFrame = 0;
function renderSoon() {
  if (!renderFrame) renderFrame = requestAnimationFrame(() => { renderFrame = 0; render(); });
}

function render() {
  if (!home) return;
  if (state.agent && !covers.loaded && !covers.loading) { covers.loading = true; loadCovers().then(() => { covers.loading = false; renderSoon(); }); }
  homeScroll = scroller.scrollTop;
  const sessions = [...state.sessions].sort((a, b) => (b.last_active ?? b.started_at ?? 0) - (a.last_active ?? a.started_at ?? 0));
  const running = runningSessionIds(state.agent);
  const ordered = sessions.filter((s) => running.has(s.id)).concat(sessions.filter((s) => !running.has(s.id)));
  const circles = ordered.slice(0, STORIES);
  const viewerItems = circles.map((s) => ({ id: s.id, title: sessionTitle(s), time: ago(s.last_active ?? s.started_at), running: running.has(s.id) }));
  const strip = h('div', { className: 'fh-stories', role: 'list', 'aria-label': t('sessions.recent') },
    story({ label: t('chat.new'), isNew: true }),
    ...(listed ? [] : Array.from({ length: 6 }, storySkeleton)),
    ...circles.map((s, index) => story({
      label: sessionTitle(s), id: s.id, running: running.has(s.id),
      fresh: (s.last_active ?? s.started_at ?? 0) > seenAt(s.id),
      // A circle is a quick look at the chat's latest reply; the post below it opens the chat itself.
      onClick: () => import('./story-viewer.js').then(({ openStoryViewer }) => openStoryViewer({
        items: viewerItems.map((item) => ({ ...item, time: item.time })),
        start: index,
        load: latestReply,
        onOpen: open,
        onSeen: markSeen,
        onCopy: async (text) => notify((await copyText(text)) ? t('feed.story.copied') : t('common.copyFailed')),
        onClose: () => render(),
      })),
    })),
    // The rest of the chat history: the same list as the search panel.
    ...(listed ? [story({ label: t('feed.seeAll'), glyph: 'search', onClick: () => openPanel('chat') })] : []));
  // Desktop: arrows at the ends of the row (as on Instagram) so a circle cut by the edge reads as "more this way".
  const prev = h('button', { type: 'button', className: 'fh-arrow fh-arrow-prev', 'aria-label': t('feed.story.prevStory'), tabindex: '-1' }, icon('chevron-right', 16));
  const next = h('button', { type: 'button', className: 'fh-arrow fh-arrow-next', 'aria-label': t('feed.story.nextStory'), tabindex: '-1' }, icon('chevron-right', 16));
  const stories = h('div', { className: 'fh-stories-wrap' }, strip, prev, next);
  const edges = () => {
    stories.classList.toggle('has-prev', strip.scrollLeft > 2);
    stories.classList.toggle('has-next', strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2);
  };
  prev.addEventListener('click', () => strip.scrollBy({ left: -strip.clientWidth * 0.7, behavior: 'smooth' }));
  next.addEventListener('click', () => strip.scrollBy({ left: strip.clientWidth * 0.7, behavior: 'smooth' }));
  strip.addEventListener('scroll', edges, { passive: true });
  strip.scrollLeft = storiesScroll;
  strip.addEventListener('scroll', () => { storiesScroll = strip.scrollLeft; }, { passive: true });
  storiesHost.replaceChildren(stories);
  aside.replaceWith((aside = asideNode(sessions, running)));
  scroller.scrollTop = homeScroll;
  requestAnimationFrame(() => { strip.scrollLeft = storiesScroll; edges(); });
  paintThumbs();
  if (covers.loaded) for (const s of circles.slice(0, COVER_DRAW)) wantCover(s.id, null);
}

// Right column (desktop): your account and the chats that were active most recently, small and quiet.
const ASIDE_CHATS = 5;
function asideNode(sessions, running) {
  const me = state.me?.username ?? '';
  const rows = sessions.slice(0, ASIDE_CHATS).map((s) => {
    const live = running.has(s.id);
    const row = h('div', { className: `fh-mini${live ? ' is-running' : ''}`, role: 'button', tabindex: '0', 'data-id': s.id },
      h('span', { className: 'fh-av' }, initial(sessionTitle(s))),
      h('span', { className: 'fh-mini-text' }, h('b', {}, sessionTitle(s)), h('small', {}, live ? t('feed.story.replying') : `${ago(s.last_active ?? s.started_at)}${s.message_count ? ` · ${t('feed.messageCount', { n: s.message_count })}` : ''}`)),
      h('span', { className: 'fh-link fh-mini-act' }, t('feed.open')));
    row.addEventListener('click', () => open(s.id));
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(s.id); } });
    return row;
  });
  return h('aside', { className: 'fh-aside', 'aria-label': t('feed.activeChats') },
    h('div', { className: 'fh-account' }, h('span', { className: 'fh-av fh-av-lg' }, me ? initial(me) : ''),
      h('span', { className: 'fh-mini-text' }, h('b', {}, me), h('small', {}, state.agent ?? APP_NAME)),
      h('button', { type: 'button', className: 'fh-link', onClick: () => emit('feed:settings') }, t('settings.title'))),
    h('div', { className: 'fh-aside-head' }, h('b', {}, t('feed.recentChats')), h('button', { type: 'button', className: 'fh-link fh-link-dark', onClick: () => openPanel('chat') }, t('feed.seeAll'))),
    ...rows,
    h('p', { className: 'fh-fine' }, t('feed.copyright', { year: new Date().getFullYear(), app: APP_NAME })));
}

function setView(next) {
  view = next;
  if (view === 'home') writeHash('#/home'); else if (!state.sessionId) writeHash('#/new');
  root.setAttribute('data-feed-view', view);
  if (view === 'home') {
    requestAnimationFrame(render);
    if (!freshStarted) { freshStarted = true; fresh.start(); }
  }
}

// Scrolls to exactly 0 in about 350 ms at any depth: far away it first jumps to one screen from the top, then eases out (own
// animation: native smooth scrolling is cut by any layout change and its length depends on the distance). Touching or wheeling stops it.
function animateToTop(el) {
  return new Promise((resolve) => {
    const finish = () => { el.removeEventListener('touchstart', stop); el.removeEventListener('wheel', stop); resolve(); };
    const stop = () => { cancelled = true; };
    let cancelled = false;
    if (el.scrollTop <= 0) { resolve(); return; }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.scrollTop = 0; resolve(); return; }
    const screen = el.clientHeight || 600;
    if (el.scrollTop > screen * 2) el.scrollTop = screen;
    const from = el.scrollTop;
    const t0 = performance.now();
    const ms = 220 + Math.min(130, (from / screen) * 65);
    el.addEventListener('touchstart', stop, { passive: true });
    el.addEventListener('wheel', stop, { passive: true });
    const step = (now) => {
      if (cancelled) { finish(); return; }
      const progress = Math.min(1, (now - t0) / ms);
      el.scrollTop = from * (1 - (1 - (1 - progress) ** 3));
      if (progress < 1) requestAnimationFrame(step); else { el.scrollTop = 0; finish(); }
    };
    requestAnimationFrame(step);
  });
}

// The address says where you are: #/home for the feed, #/new for an empty chat, the usual #/agent/id for a chat. A refresh
// therefore comes back to the same place instead of reopening the last chat.
const startView = () => (/^#\/[^/]+\/.+/.test(location.hash) || location.hash === '#/new' ? 'chat' : 'home');
function writeHash(hash) {
  if (location.hash !== hash) navigate(hash);
}

// Desktop: the chat list slides out beside the navigation column (Instagram's search panel).
const sidebar = () => $('#sidebar');
function openPanel(kind) {
  if (mobile.matches) { emit('sidebar:open'); if (kind === 'search') setTimeout(() => $('#session-search')?.focus(), 60); return; }
  const panel = sidebar();
  panel.inert = false;
  document.body.classList.add('feed-panel-open');
  if (kind === 'search') setTimeout(() => $('#session-search')?.focus(), 60);
}
function closePanel() {
  if (!document.body.classList.contains('feed-panel-open')) return;
  document.body.classList.remove('feed-panel-open');
  if (!mobile.matches) sidebar().inert = true;
}

export function initFeedShell() {
  const app = $('.app');
  const opener = $('#open-sidebar');
  const mainEl = $('#main');
  if (!app || !opener || !mainEl) return;

  storiesHost = h('div', { className: 'fh-stories-host' });
  main = h('div', { className: 'fh-main' }, storiesHost);
  scroller = h('div', { className: 'fh-scroll', 'data-testid': 'feed-home-scroll' }, h('div', { className: 'fh-layout' }, main, aside));
  // "Ask <agent>" on a story: an empty chat with the story already written in the box, ready to send.
  const ask = (item) => {
    emit('session:select', null);
    const text = t('feed.ask.prompt', { title: item.original || item.title, url: item.url, summary: item.summary });
    setTimeout(() => window.dispatchEvent(new CustomEvent('hermes:shared', { detail: { text } })), 250);
  };
  fresh = createFresh({ scroller, ask });
  main.append(fresh.el);
  // Pull to refresh on the home asks for new stories too.
  // The spinner must not wait for a slow network: it stops after 0.9 s at most while the refresh finishes by itself.
  on('fresh:refresh', (job) => {
    job.tasks.push(Promise.race([fresh.refresh({ announce: true }), new Promise((r) => setTimeout(r, 900))]));
  });
  const inbox = h('button', { type: 'button', className: 'ibtn fh-inbox', 'aria-label': t('telegram.import'), title: t('telegram.import'), 'data-testid': 'feed-inbox', onClick: () => $('#telegram-open')?.click() }, icon('send', 24));
  home = h('section', { className: 'feed-home', 'aria-label': t('feed.home'), 'data-testid': 'feed-home' },
    // The header wordmark is the logo text, not UI copy: it is left untouched in this task.
    h('header', { className: 'fh-bar' }, h('span', { className: 'fh-brand' }, 'aixell'), inbox),
    scroller);
  mainEl.append(home);

  // ---- phone: icon tab bar ----
  const tab = (name, label, onClick) => h('button', { type: 'button', className: 'feed-tab', 'aria-label': label, title: label, 'data-tab': label.toLowerCase(), onClick }, typeof name === 'string' ? icon(name, 26) : name);
  // Tapping Home always means: the home feed, the "All" chip, the very top, and a refresh (chat list and stories), also when already there.
  // setView only writes the address when it differs, so tapping Home on the home feed adds no history entry.
  // The scroll goes first and nothing is re-rendered while it runs (a re-render sets scrollTop by itself and cuts the animation short);
  // the refresh starts when the story row is fully visible.
  const tapHome = () => {
    setView('home');
    paint();
    animateToTop(scroller).then(() => { loadSessions({ silent: true }); fresh.home(); });
  };
  const closeDrawer = () => { if (document.body.classList.contains('sidebar-open')) $('#scrim').click(); };
  const meFace = () => h('span', { className: 'fh-ring fh-ring-tab' }, h('span', { className: 'fh-face' }, me0()));
  const tabHome = tab('home', t('feed.home'), () => { closeDrawer(); tapHome(); });
  const tabSearch = tab('search', t('feed.search'), () => openPanel('search'));
  const tabNew = tab('square-plus', t('chat.new'), () => { closeDrawer(); open(null); });
  const tabUsage = tab('bar-chart', t('usage.title'), () => emit('feed:usage'));
  const tabMe = tab(meFace(), t('account.menu.label'), () => emit('feed:account', tabMe));
  const tabs = h('nav', { className: 'feed-nav', 'aria-label': t('feed.nav'), 'data-testid': 'feed-nav' }, tabHome, tabSearch, tabNew, tabUsage, tabMe);
  document.body.append(tabs);

  // ---- desktop: navigation column ----
  const item = (name, label, onClick, extra = '') => h('button', { type: 'button', className: `feed-side-item ${extra}`.trim(), 'data-nav': label.toLowerCase(), onClick }, typeof name === 'string' ? icon(name, 26) : name, h('span', { className: 'feed-side-label' }, label));
  const sHome = item('home', t('feed.home'), () => { closePanel(); tapHome(); });
  const sSearch = item('search', t('feed.searchTitle'), () => (document.body.classList.contains('feed-panel-open') ? closePanel() : openPanel('search')));
  // Search and the chat list are one panel, so there is one entry for it; the paper plane is the Telegram import.
  const sTelegram = item('send', t('feed.importShort'), () => { closePanel(); $('#telegram-open')?.click(); });
  const sNew = item('square-plus', t('chat.new'), () => { closePanel(); open(null); });
  const sUsage = item('bar-chart', t('usage.title'), () => emit('feed:usage'));
  const sMe = item(meFace(), t('settings.title'), () => emit('feed:settings'));
  const sMore = item('menu', t('feed.more'), () => emit('feed:account', sMore), 'feed-side-more');
  const NAV_KEY = 'hermes.feedNav';
  const toggle = h('button', { type: 'button', className: 'ibtn feed-side-toggle', 'aria-label': t('feed.nav.collapse'), title: t('feed.nav.collapseHint'), 'data-testid': 'feed-side-toggle' }, icon('chevron-right', 14));
  const paintToggle = () => { const mini = root.getAttribute('data-feed-nav') === 'mini'; toggle.setAttribute('aria-label', mini ? t('feed.nav.expand') : t('feed.nav.collapse')); toggle.setAttribute('aria-expanded', String(!mini)); };
  toggle.addEventListener('click', () => {
    const mini = root.getAttribute('data-feed-nav') === 'mini';
    if (mini) root.removeAttribute('data-feed-nav'); else root.setAttribute('data-feed-nav', 'mini');
    try { if (mini) localStorage.removeItem(NAV_KEY); else localStorage.setItem(NAV_KEY, 'mini'); } catch { /* applies to this page only */ }
    paintToggle();
  });
  paintToggle();
  const side = h('nav', { className: 'feed-side', 'aria-label': t('feed.nav.main'), 'data-testid': 'feed-side' }, h('span', { className: 'feed-side-brand' }, h('b', {}, 'aixell'), h('i', {}, 'a')), sHome, sSearch, sTelegram, sNew, sUsage, sMe, sMore);
  side.append(toggle);
  app.prepend(side);
  document.addEventListener('pointerdown', (event) => {
    if (!document.body.classList.contains('feed-panel-open')) return;
    if (!event.target.closest('#sidebar, .feed-side, .pop, .menu, .dlg')) closePanel();
  });

  const paint = () => {
    const searching = document.body.classList.contains('sidebar-open');
    const panel = document.body.classList.contains('feed-panel-open');
    tabHome.setAttribute('aria-current', String(view === 'home' && !searching));
    tabSearch.setAttribute('aria-current', String(searching));
    sHome.setAttribute('aria-current', String(view === 'home' && !panel));
    sSearch.setAttribute('aria-current', String(panel));
    sNew.setAttribute('aria-current', String(view === 'chat' && !state.sessionId && !panel));
  };

  const goHome = () => { closeDrawer(); closePanel(); setView('home'); paint(); };
  // Phone: the chat's left button becomes a back arrow to the home feed.
  opener.addEventListener('click', (event) => {
    if (!mobile.matches || view !== 'chat' || document.body.classList.contains('sidebar-open')) return;
    event.stopImmediatePropagation();
    goHome();
  }, true);

  on('session:select', () => { closePanel(); setView('chat'); paint(); });
  // The app writes the open chat into the address after every change; the home feed (or an empty chat) takes its own back.
  on('session:changed', () => { setTimeout(() => { if (view === 'home') writeHash('#/home'); else if (!state.sessionId) writeHash('#/new'); }, 0); });
  // Back / forward between the home feed, an empty chat and a chat.
  window.addEventListener('hashchange', () => {
    if (history.state?.guard) return;
    const route = readRoute();
    if (location.hash === '#/home') { if (view !== 'home') { setView('home'); paint(); } }
    else if (location.hash === '#/new') { if (view !== 'chat' || state.sessionId) open(null); }
    // A chat that is already the selected one is not re-selected by the app, but the screen may still be the home feed.
    else if (route && route.id === state.sessionId && view !== 'chat') open(route.id);
  });
  for (const type of ['sessions:loaded', 'sessions:failed']) on(type, () => { listed = true; if (view === 'home') renderSoon(); });
  on('run:state', () => { if (view === 'home') renderSoon(); });
  const faces = () => { for (const el of document.querySelectorAll('.fh-ring-tab .fh-face, .feed-side-item .fh-face')) el.textContent = me0(); };
  on('agent:select', () => { covers.loaded = false; covers.enabled = true; covers.ids = new Set(); listed = false; faces(); });
  // The account arrives after the first draw: the initials on the tab bar and the right column follow.
  on('me:loaded', () => { faces(); if (view === 'home') renderSoon(); });
  new MutationObserver(paint).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  new ResizeObserver(() => { if (view === 'home') renderSoon(); }).observe(scroller);

  const apply = () => {
    const back = mobile.matches;
    opener.classList.toggle('feed-back', back);
    opener.replaceChildren(icon(back ? 'chevron-right' : 'panel-left', 20));
    if (!mobile.matches && !document.body.classList.contains('feed-panel-open')) sidebar().inert = true;
    setView(startView());
    paint();
  };
  mobile.addEventListener('change', apply);
  apply();
}
