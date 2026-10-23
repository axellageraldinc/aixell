// Entry point of the main page: wires the UI modules together, then loads the user and the agents.
import { $ } from './lib/dom.js';
import { api, setCsrf } from './lib/api.js';
import { state, boot as booting, on, emit, readLastAgent, readBootAgent, saveBootAgent, readRoute, writeRoute } from './lib/state.js';
import { hydrateIcons } from './lib/icons.js';
import { notify } from './lib/ui.js';
import { openMenu } from './lib/menu.js';
import { loadAgents, guessAgent, selectInitialAgent, syncAgentStatus } from './lib/agents.js';
import { initSessions } from './lib/sessions.js';
import { initMessages, loadSession } from './lib/messages.js';
import { initScroll } from './lib/scroll.js';
import { initFindInChat } from './lib/find-in-chat.js';
import { initDisplay } from './lib/display.js';
import { initFeed } from './lib/feed.js';
import { initFeedShell } from './lib/feed-shell.js';
import { initTelegramEntry } from './lib/telegram-chats.js';
import { takeShared } from './lib/share.js';
import { initPullRefresh } from './lib/pull-refresh.js';
import { initBackNav } from './lib/back-nav.js';
import { initComposer } from './lib/composer.js';
import { initHeader } from './lib/header.js';
import { initInspector } from './lib/inspector.js';
import { initUsage } from './lib/usage.js';
import { initQuotaBanner } from './lib/quota-banner.js';
import { initRedo } from './lib/redo.js';
import { registerWorker } from './lib/push.js';
import { initSelectGuard } from './lib/select-guard.js';
import { initUpdateCheck } from './lib/version.js';
import { initDiag } from './lib/diag.js';
import { initLayout } from './lib/layout.js';
import { initViewport } from './lib/viewport.js';
import { loadModels } from './lib/models.js';
import { t } from './lib/i18n.js';

const offlineBanner = $('#offline-banner');

// The big panels are fetched the first time they are opened, so start-up does not load and parse code nobody asked for yet.
const unavailable = () => notify(t('app.loadFailed'));
const openUsage = () => import('./lib/provider-usage.js').then((m) => m.openUsage(), unavailable);
const openKnowledge = () => import('./lib/knowledge.js').then((m) => m.openKnowledge(), unavailable);
const openSettings = (options) => import('./lib/agent-settings.js').then((m) => m.openSettings(options), unavailable);

// A link such as #/default/<chat id> opens that chat once (a reload keeps it). Without one, the app opens on a blank chat.
let startRoute = readRoute();

function onAgentSelect() {
  syncAgentStatus();
  loadModels();
  const route = startRoute;
  startRoute = null;
  loadSession(route && route.agent === state.agent ? route.id : null);
}

async function signOut(path) {
  try {
    await api(path, { method: 'POST' });
    location.href = '/login.html';
  } catch (err) {
    notify(err.message);
  }
}

function bindUserMenu() {
  const button = $('#user-menu');
  const show = (anchor) => {
    openMenu(
      anchor,
      [
        { label: t('usage.title'), testid: 'usage-open', action: openUsage },
        { label: t('knowledge.title'), testid: 'knowledge-open', action: openKnowledge },
        { label: t('inspector.title'), testid: 'inspector-open', action: () => emit('inspector:toggle') },
        { label: t('settings.title'), testid: 'settings-open', action: () => openSettings({ signOutAll: () => signOut('/api/logout-all') }) },
        { separator: true },
        { label: t('account.signOut'), testid: 'sign-out', action: () => signOut('/api/logout') },
      ],
      t('account.menu.label'),
    );
  };
  button.addEventListener('click', () => show(button));
  // The Feed style has its own account button (bottom tab bar).
  on('feed:account', show);
  on('feed:usage', () => openUsage());
  on('feed:settings', () => openSettings({ signOutAll: () => signOut('/api/logout-all') }));
}

// The splash in index.html covers the app until the composer works (everything is wired and has been drawn once). The
// chat list, feed, models and usage fill in behind it, as skeletons first.
function dismissSplash() {
  const splash = document.getElementById('boot-splash');
  if (!splash) return;
  splash.classList.add('is-gone');
  setTimeout(() => splash.remove(), 260);
}

async function boot() {
  // Ask for the account and the agent list first: they are on the network while the screen is wired up below. Nothing
  // else waits for them: the last used agent is assumed, so its chats and models load at the same time.
  const meLoading = api('/api/me');
  meLoading.catch(() => {}); // handled below, once the screen is wired
  const agentsLoading = loadAgents();
  setTimeout(dismissSplash, 8000);
  initBackNav(notify);
  hydrateIcons();
  initViewport();
  initLayout();
  initScroll();
  initFindInChat();
  initDisplay();
  initFeed();
  initFeedShell();
  initTelegramEntry();
  initPullRefresh();
  initSessions();
  initMessages();
  initComposer();
  initHeader();
  initInspector();
  initQuotaBanner();
  initRedo();
  registerWorker();
  initSelectGuard();
  initUpdateCheck();
  initDiag();
  initUsage();
  bindUserMenu();

  on('agent:select', onAgentSelect);
  on('session:changed', () => writeRoute(state.agent, state.sessionId));
  window.addEventListener('hashchange', () => {
    if (history.state?.guard) return;
    const route = readRoute();
    if (!route || (route.agent === state.agent && route.id === state.sessionId)) return;
    if (route.agent === state.agent) emit('session:select', route.id);
    else location.reload();
  });
  on('agent:status', () => {
    offlineBanner.hidden = !state.agentOffline;
  });

  // Only names that once came from the real agent list (bootAgent) or a link are guessed; a stale lastAgent is not.
  guessAgent(startRoute?.agent ?? readBootAgent());
  // Two frames: the first draws what was just built, the second is when the composer can be touched.
  requestAnimationFrame(() => requestAnimationFrame(dismissSplash));
  try {
    const me = await meLoading;
    setCsrf(me.csrf);
    state.me = me;
    $('#username').textContent = me.username;
    $('#username').dataset.initial = me.username.slice(0, 1);
    emit('me:loaded');
  } catch (err) {
    dismissSplash();
    booting.done();
    notify(err.message);
    return;
  }
  await agentsLoading;
  selectInitialAgent(startRoute?.agent ?? readLastAgent());
  saveBootAgent(state.agent);
  booting.done();
  // Something shared to the app from the system Share sheet: it opens in a new chat, ready to send.
  const shared = await takeShared();
  if (shared) {
    emit('session:select', null);
    window.dispatchEvent(new CustomEvent('hermes:shared', { detail: shared }));
  }
}

boot();
