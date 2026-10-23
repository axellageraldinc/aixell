// A minimal Chrome DevTools Protocol driver (no dependencies): finds a locally installed Chrome or Chromium, starts it headless
// with a throw-away profile on a random debugging port, and exposes a small page API for the smoke tests.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// CHROME_BIN wins; then well-known names on PATH; then a Playwright download (chromium or its headless shell); then macOS app bundles.
export function findChrome() {
  const candidates = [];
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'chrome-headless-shell']) {
    const found = spawnSync('which', [name], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) candidates.push(found.stdout.trim());
  }
  const playwright = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const dir of fs.readdirSync(playwright).sort().reverse()) {
      if (!/^chromium/.test(dir)) continue;
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) candidates.push(path.join(playwright, dir, rel));
    }
  } catch { /* no Playwright cache */ }
  candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  return candidates.find((file) => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } }) ?? null;
}

// Phone and desktop presets used by the tests.
export const VIEWPORTS = {
  phone: { width: 390, height: 800, deviceScaleFactor: 2, mobile: true, touch: true },
  desktop: { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false, touch: false },
};

// -> { ev, waitFor, click, type, navigate, screenshot, problems, close, ... }
export async function launchBrowser(bin, { viewport = VIEWPORTS.desktop } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-web-chrome-'));
  const proc = spawn(bin, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--mute-audio',
    `--window-size=${viewport.width},${viewport.height}`, 'about:blank',
  ], { stdio: 'ignore' });
  const cleanup = () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ } };
  let exited = false;
  proc.once('exit', () => { exited = true; });

  // Chrome writes the port it picked to <profile>/DevToolsActivePort.
  let port = 0;
  for (let i = 0; i < 100 && !port && !exited; i += 1) {
    try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(100); }
  }
  if (!port) { proc.kill(); cleanup(); throw new Error('Chrome did not start (no DevTools port)'); }

  let target;
  for (let i = 0; i < 50 && !target; i += 1) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* retry */ }
    if (!target) await sleep(100);
  }
  if (!target) { proc.kill(); cleanup(); throw new Error('Chrome has no page to drive'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools socket failed')); });

  let nextId = 0;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') problems.push(`exception: ${(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).slice(0, 300)}`);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300)}`);
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') problems.push(`log: ${msg.params.entry.text} ${msg.params.entry.url || ''}`.slice(0, 300));
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools call ${method} timed out`)); }, 30_000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');

  const page = {
    send, problems,
    // Evaluates an expression in the page (awaiting promises) and returns its value; throws on a page exception.
    async ev(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(`page error: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
      return r.result?.result?.value;
    },
    async waitFor(expression, { timeoutMs = 15_000, what = expression } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let value;
        try { value = await page.ev(expression); } catch { value = false; } // the page may be mid-navigation
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
        await sleep(100);
      }
    },
    async viewport({ width, height, deviceScaleFactor, mobile, touch }) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
      await send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 0 });
    },
    // Runs a script before any page script on every new document (used to preset localStorage).
    addInitScript: (source) => send('Page.addScriptToEvaluateOnNewDocument', { source }),
    async navigate(url) { await send('Page.navigate', { url }); await sleep(150); await page.waitFor("document.readyState !== 'loading'", { what: 'page load' }); },
    // Center of the first element matching the selector, in CSS pixels (null when it is missing or has no size).
    box: (selector) => page.ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height } : null; })()`),
    async click(selector) {
      await page.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, { what: `element ${selector}` });
      await page.ev(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
      const b = await page.box(selector);
      if (!b) throw new Error(`${selector} has no box`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    },
    // Like click, for the first element that is actually on screen (the same control can exist in a hidden phone and desktop layout).
    async clickVisible(selector) {
      await page.waitFor(`[...document.querySelectorAll(${JSON.stringify(selector)})].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })`, { what: `visible ${selector}` });
      await page.ev(`(() => { for (const e of document.querySelectorAll('[data-cdp-target]')) e.removeAttribute('data-cdp-target'); const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); e.setAttribute('data-cdp-target', ''); })()`);
      await page.click('[data-cdp-target]');
    },
    async tap(selector) {
      const b = await page.box(selector);
      if (!b) throw new Error(`${selector} has no box`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x, y: b.y }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    // A finger drag from (x, y) by dy pixels, in small steps.
    async drag(x, y, dy, steps = 12) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= steps; i += 1) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * i) / steps }] }); await sleep(16); }
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    // Sets the value of a form field the way a user typing would (fires input events).
    setValue: (selector, value) => page.ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`),
    async press(key) {
      const codes = { Enter: 13, Escape: 27 };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: codes[key], ...(key === 'Enter' ? { text: '\r' } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: codes[key] });
    },
    async screenshot(file) { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); },
    async close() { try { ws.close(); } catch { /* closing */ } proc.kill('SIGKILL'); await new Promise((resolve) => { if (exited) resolve(); else proc.once('exit', resolve); }); cleanup(); },
  };
  await page.viewport(viewport);
  return page;
}
