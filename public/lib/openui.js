// Renders an `openui` fenced block (openui-lang from the model) into live React components.
//
// The bundle is 3.2 MB, so it is fetched only when a chat actually shows a visual block, and only once per page.
// The vendored files live under public/vendor/openui/ (MIT); the script is a classic <script> that defines
// window.__OpenUI, so it loads fine under this app's CSP (no inline code, no eval, no eval-like constructs).
//
// Everything below stays inside the CSP: React builds nodes, and the app never sets innerHTML on our side.
import { h } from './dom.js';
import { state } from './state.js';
import { t } from './i18n.js';

const BASE = '/vendor/openui';
const VERSION = '0.2.1';
const SCRIPT = `${BASE}/openui-bundle-${VERSION}.min.js`;
const STYLE = `${BASE}/openui-styles-${VERSION}.css`;

// A failing block must never break the reply: each mount is isolated and reports its own error.
const MAX_CHARS = 40_000; // a runaway program is a bug, not a chart

let bundlePromise = null;
let styleReady = false;

// OpenUI ships its own light/dark palettes keyed on a data attribute; the app's theme is Primer's, so the two have to
// agree. Primer's dark is data-color-mode="dark" (or "auto" + a dark system), which is what this mirrors.
function applyTheme() {
  const mode = document.documentElement.getAttribute('data-color-mode') ?? 'light';
  const dark = mode === 'dark' || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-openui-theme', dark ? 'dark' : 'light');
}

function ensureStyle() {
  if (styleReady) return;
  const link = h('link', { rel: 'stylesheet', href: STYLE });
  document.head.append(link);
  styleReady = true;
  applyTheme();
  // Follow the app's theme toggle while the page stays open.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-mode'] });
}

function loadBundle() {
  if (window.__OpenUI) return Promise.resolve(window.__OpenUI);
  if (bundlePromise) return bundlePromise;
  bundlePromise = new Promise((resolve, reject) => {
    const script = h('script', { src: SCRIPT, onLoad: () => (window.__OpenUI ? resolve(window.__OpenUI) : reject(new Error('OpenUI loaded without an API.'))), onError: () => reject(new Error('The OpenUI bundle could not be loaded.')) });
    document.head.append(script);
  }).catch((error) => {
    bundlePromise = null; // a later block may retry
    throw error;
  });
  return bundlePromise;
}

// One React root per block. A block inside a streaming reply is updated in place (a fresh root per token would thrash
// React and lose scroll position); the caller keeps the handle so it can be unmounted when the node leaves the DOM.
// streaming: the program is still being written, so an empty frame is expected and must not be turned into a fallback.
export function mountOpenUI(container, source, { streaming = false } = {}) {
  const initial = String(source ?? '').trim();
  if (!initial) return null;
  ensureStyle();
  let disposed = false;
  let root = null;
  let code = initial;
  let api = null;
  let pending = streaming;
  let checkTimer = 0;
  let settleTimer = 0;

  const fail = (message) => {
    if (disposed) return;
    // The React root has to go with the host it was rendering into: keeping it would leave `root` pointing at a
    // detached node, and the next update (the finished program) would render into nothing.
    try { root?.unmount(); } catch { /* already gone */ }
    root = null;
    container.replaceChildren(fallback(code, message));
  };

  // A program the parser accepts but the library cannot draw (a component used as root, a bad argument) renders an
  // empty div and reports nothing. Checked only when the text is final: mid-stream the frame is legitimately empty
  // until the first statement arrives, and turning that into a fallback would replace a chart that was about to
  // appear.
  const scheduleCheck = () => {
    clearTimeout(settleTimer);
    if (pending) return;
    settleTimer = setTimeout(() => {
      const host = container.querySelector('.openui-host');
      if (disposed || pending || !host?.isConnected) return;
      if (host.childElementCount === 0) fail(t('openui.error.empty'));
    }, 1200);
  };

  const render = () => {
    if (!api || disposed) return;
    const { React, createRoot, Renderer, openuiChatLibrary } = api;
    // A host that was replaced (by a fallback, or by the previous render) is not usable any more.
    let host = container.querySelector('.openui-host');
    if (!host || !root) {
      host = h('div', { className: 'openui-host', 'data-testid': 'openui-block' });
      container.replaceChildren(host);
      root = createRoot(host);
    }
    root.render(
      React.createElement(Renderer, {
        response: code,
        library: openuiChatLibrary,
        // A button with @ToAssistant sends its text as the next message; @OpenUrl opens a tab. Both are user
        // gestures, so no confirmation is needed, and the URL is checked before it is opened.
        onAction: (action) => handleAction(action),
        // The renderer calls this on every pass, with an empty object when nothing is wrong: only a payload that
        // actually carries a message means the program could not be parsed.
        onError: (error) => {
          const message = typeof error === 'string' ? error : error?.message;
          if (message) fail(t('openui.error.detail', { message }));
        },
      }),
    );
    scheduleCheck();
  };

  loadBundle()
    .then((loaded) => {
      if (disposed || !container.isConnected) return;
      api = loaded;
      render();
      checkTimer = 1;
    })
    .catch((error) => fail(error.message));

  return {
    container,
    source: () => code,
    // True when the renderer produced nothing at all: the caller uses this to remount with the finished program.
    isEmpty: () => {
      const host = container.querySelector('.openui-host');
      return !host || host.childElementCount === 0;
    },
    // New text for the same block while the reply streams in.
    update(next, { streaming = false } = {}) {
      const text = String(next ?? '').trim();
      pending = streaming;
      if (disposed || text === code) {
        if (!streaming) scheduleCheck();
        return;
      }
      code = text;
      if (code.length > MAX_CHARS) {
        fail(t('openui.error.tooLarge'));
        return;
      }
      render();
    },
    destroy() {
      disposed = true;
      clearTimeout(checkTimer);
      clearTimeout(settleTimer);
      try { root?.unmount(); } catch { /* already gone */ }
      root = null;
    },
  };
}

// The reply must never lose content: when a program cannot be drawn, its source is shown the way a code fence would
// have been, with a one-line note saying why.
function fallback(code, message) {
  return h(
    'div',
    { className: 'openui-fallback' },
    h('p', { className: 'openui-error' }, message),
    h('div', { className: 'code-block' }, h('div', { className: 'code-head' }, h('span', { className: 'code-lang' }, 'openui')), h('pre', {}, h('code', {}, code))),
  );
}

// Buttons in a generated block do two things: continue the conversation, or open a link the model supplied.
function handleAction(action) {
  if (!action) return;
  const type = action.type ?? 'continue_conversation';
  if (type === 'open_url') {
    const raw = action.params?.url;
    let url = null;
    try {
      const parsed = new URL(String(raw));
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = parsed.href;
    } catch { /* not a URL: ignore */ }
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  if (type === 'continue_conversation') {
    const text = String(action.humanFriendlyMessage ?? '').trim();
    if (text) sendAsUser(text);
  }
}

// The composer owns sending; a button inside a generated block asks it to send a message, exactly like pressing Send.
function sendAsUser(text) {
  if (!state.agent) return;
  window.dispatchEvent(new CustomEvent('hermes:send-text', { detail: { text } }));
}
