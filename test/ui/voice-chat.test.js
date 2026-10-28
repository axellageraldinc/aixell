// Voice chat: the overlay opens from the composer, records, sends the transcript through the normal chat flow, speaks the
// reply with the words highlighted as they are said, and comes back to idle. A fake MediaRecorder stands in for the
// microphone, the transcription call is answered in the page, and the speech provider is a local fake that returns a
// short WAV, so nothing here reaches a real service.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { boot, totp, TOTP_SECRET, USERNAME, PASSWORD } from '../helpers/boot.js';
import { REPLY_TEXT } from '../fake-hermes/server.js';
import { startFakeGateway, GW_KEY } from '../helpers/fake-gateway.js';
import { findChrome, launchBrowser, VIEWPORTS } from './cdp.js';

const bin = findChrome();
const skip = bin ? false : 'no Chrome or Chromium found';

// One second of a quiet 220 Hz tone as a 16-bit mono WAV.
function wav(seconds = 1, rate = 22050) {
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 3000), 44 + i * 2);
  return buf;
}

const FAKES = `
  navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
  window.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() { this.mimeType = 'audio/webm'; this.state = 'inactive'; this.on = {}; }
    set ondataavailable(fn) { this.on.dataavailable = fn; }
    set onstop(fn) { this.on.stop = fn; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.on.dataavailable({ data: new Blob(['webm-bytes'], { type: 'audio/webm' }) }); this.on.stop(); }
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, init) => {
    if (/\\/uploads\\/[^/]+\\/transcribe$/.test(String(url))) return Promise.resolve(new Response('{"text":"halo"}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    return realFetch(url, init);
  };
`;

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  describe(`voice chat (${name} ${viewport.width}x${viewport.height})`, { skip }, () => {
    let app, page, gw;
    before(async () => {
      gw = await startFakeGateway();
      gw.handlers['POST /audio/speech'] = () => ({ status: 200, headers: { 'Content-Type': 'audio/wav' }, raw: wav(1.2) });
      const providers = {
        providers: { gw: { type: 'openai-compatible', baseUrl: gw.url, apiKey: 'env:HW_VOICE_KEY' } },
        capabilities: { speech: { provider: 'gw', model: 'tts-test', voice: 'v1' } },
      };
      app = await boot({ fake: { sessions: 2 }, env: { HW_VOICE_KEY: GW_KEY }, files: { 'providers.json': JSON.stringify(providers) } });
      page = await launchBrowser(bin, { viewport });
      await page.addInitScript(FAKES);
      await page.navigate(`${app.base}/`);
      await page.waitFor("location.pathname === '/login.html'", { what: 'the login page' });
      await page.ev(`(() => { const f = document.querySelector('form'); const i = f.querySelectorAll('input');
        i[0].value = ${JSON.stringify(USERNAME)}; i[1].value = ${JSON.stringify(PASSWORD)}; i[2].value = ${JSON.stringify(totp(TOTP_SECRET))};
        f.requestSubmit(); })()`);
      await page.waitFor("location.pathname !== '/login.html'", { what: 'signed in' });
      await page.waitFor("document.querySelector('#model-chip')", { what: 'the app' });
    });
    after(async () => {
      await page?.close();
      await app?.stop();
      await gw?.close();
    });

    test('the stop tap works even when the timer redraws the screen between the press and the release', async () => {
      await page.waitFor("document.querySelector('.session-row')", { what: 'a chat in the list' });
      await page.ev("document.querySelector('.session-row').click()");
      await page.waitFor("document.querySelector('#voice-button') && !document.querySelector('#voice-button').hidden", { what: 'the voice button' });
      await page.clickVisible('[data-testid="voice-button"]');
      await page.waitFor("!!document.querySelector('[data-testid=\"voice-overlay\"]')", { what: 'the overlay' });
      await page.clickVisible('[data-testid="voice-orb"]');
      await page.waitFor("document.querySelector('[data-testid=\"voice-orb\"]').dataset.state === 'recording'", { what: 'recording' });
      await new Promise((resolve) => setTimeout(resolve, 900));
      await page.clickHold('[data-testid="voice-orb"]', 700); // the timer ticks every 250 ms: several redraws happen while the button is down
      await page.waitFor("document.querySelector('[data-testid=\"voice-orb\"]').dataset.state !== 'recording'", { what: 'the recording stopped', timeoutMs: 5000 });
      await page.ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await page.waitFor("!document.querySelector('[data-testid=\"voice-overlay\"]')", { what: 'the overlay closed' });
    });

    test('talk, get the reply spoken with highlighted words, and end idle', async () => {
      await page.waitFor("document.querySelector('.session-row')", { what: 'a chat in the list' });
      await page.ev("document.querySelector('.session-row').click()");
      await page.waitFor("!!document.querySelector('[data-testid=\"composer-input\"]')", { what: 'the composer' });
      await page.waitFor("document.querySelector('#voice-button') && !document.querySelector('#voice-button').hidden", { what: 'the voice button' });
      const before = app.fake.chatBodies.length;

      await page.clickVisible('[data-testid="voice-button"]');
      await page.waitFor("!!document.querySelector('[data-testid=\"voice-overlay\"]')", { what: 'the overlay' });
      assert.equal(await page.ev("document.querySelector('[data-testid=\"voice-orb\"]').dataset.state"), 'idle');

      await page.clickVisible('[data-testid="voice-orb"]');
      await page.waitFor("document.querySelector('[data-testid=\"voice-orb\"]').dataset.state === 'recording'", { what: 'recording' });
      await page.screenshot(path.join(os.tmpdir(), `voice-${name}-recording.png`));
      await new Promise((resolve) => setTimeout(resolve, 800)); // a recording shorter than this is refused
      await page.clickVisible('[data-testid="voice-orb"]');

      await page.waitFor(`document.querySelector('[data-testid="voice-you"]').textContent === 'halo'`, { what: 'what was said' });
      await page.waitFor("document.querySelectorAll('.voice-reply .w').length > 0", { what: 'the reply words', timeoutMs: 20_000 });
      assert.equal(await page.ev("[...document.querySelectorAll('.voice-reply .w')].map((w) => w.textContent).join(' ')"), REPLY_TEXT);
      assert.equal(app.fake.chatBodies.length, before + 1, 'the transcript went to the agent once');

      // The voice starts: some word is being said, then every word is said and the orb is idle again.
      await page.waitFor("document.querySelector('.voice-reply .w.now') || document.querySelector('[data-testid=\"voice-orb\"]').dataset.state === 'speaking'", { what: 'speaking', timeoutMs: 20_000 });
      await page.screenshot(path.join(os.tmpdir(), `voice-${name}-speaking.png`));
      await page.waitFor("document.querySelector('[data-testid=\"voice-orb\"]').dataset.state === 'idle'", { what: 'idle after speaking', timeoutMs: 30_000 });
      assert.equal(await page.ev("document.querySelectorAll('.voice-reply .w.said').length === document.querySelectorAll('.voice-reply .w').length"), true, 'every word was highlighted as said');
      assert.equal(gw.count('POST /audio/speech'), 1);
      assert.deepEqual(gw.requests.find((r) => r.path === '/audio/speech').body, { model: 'tts-test', input: REPLY_TEXT, voice: 'v1', response_format: 'mp3' });
      assert.equal(await page.ev('document.documentElement.scrollWidth <= window.innerWidth + 1'), true, 'no sideways scroll');

      // Dark theme: the overlay follows the app's tokens.
      await page.ev("document.documentElement.setAttribute('data-theme', 'aixell-dark'); document.documentElement.setAttribute('data-color-mode', 'dark')");
      assert.notEqual(await page.ev("getComputedStyle(document.querySelector('[data-testid=\"voice-overlay\"]')).backgroundColor"), 'rgb(255, 255, 255)', 'the overlay has a dark background');
      await page.screenshot(path.join(os.tmpdir(), `voice-${name}-dark.png`));
      await page.ev("document.documentElement.setAttribute('data-theme', 'aixell'); document.documentElement.setAttribute('data-color-mode', 'light')");

      // The turn is in the chat history behind the overlay, and Esc closes it.
      await page.ev("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      await page.waitFor("!document.querySelector('[data-testid=\"voice-overlay\"]')", { what: 'the overlay closed' });
      await page.waitFor(`document.querySelector('[data-testid="message-list"]')?.innerText.includes(${JSON.stringify(REPLY_TEXT)})`, { what: 'the reply in the chat' });
      assert.deepEqual(page.problems, [], 'no script errors or failed requests');
    });
  });
}
