// Send while the mic is recording: the recording stops, the message goes out at once, and the upload and transcription
// run as the first step of the reply (listed in Activity, named on the working line) instead of making the owner wait
// with a chip in the tray. A fake MediaRecorder stands in for the microphone; the transcript is written by the test.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, totp, TOTP_SECRET, USERNAME, PASSWORD } from '../helpers/boot.js';
import { REPLY_TEXT } from '../fake-hermes/server.js';
import { findChrome, launchBrowser, VIEWPORTS } from './cdp.js';

const bin = findChrome();
const skip = bin ? false : 'no Chrome or Chromium found';

// No microphone in a headless browser: a recorder that "records" a few bytes of webm, and a gate on the transcribe call
// so the test decides when the transcription finishes.
const FAKES = `
  localStorage.setItem('hermes-web:mic-mode', 'record');
  navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
  window.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() { this.mimeType = 'audio/webm'; this.on = {}; }
    addEventListener(type, fn) { (this.on[type] ||= []).push(fn); }
    start() {}
    stop() { (this.on.dataavailable || []).forEach((fn) => fn({ data: new Blob(['webm-bytes'], { type: 'audio/webm' }) })); (this.on.stop || []).forEach((fn) => fn()); }
  };
  const realFetch = window.fetch.bind(window);
  window.__transcribe = { ids: [], release: null };
  window.fetch = (url, init) => {
    const m = /\\/uploads\\/([^/]+)\\/transcribe$/.exec(String(url));
    if (!m) return realFetch(url, init);
    window.__transcribe.ids.push(decodeURIComponent(m[1]));
    return new Promise((resolve) => { window.__transcribe.release = () => resolve(new Response('{"text":"halo"}', { status: 200, headers: { 'Content-Type': 'application/json' } })); });
  };
`;

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  describe(`send a recording (${name} ${viewport.width}x${viewport.height})`, { skip }, () => {
    let app, page;
    before(async () => {
      app = await boot({ fake: { sessions: 2 } });
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
    });

    test('Send during a recording sends now and transcribes inside the reply', async () => {
      await page.waitFor("document.querySelector('.session-row')", { what: 'a chat in the list' });
      await page.ev("document.querySelector('.session-row').click()");
      await page.waitFor("!!document.querySelector('[data-testid=\"composer-input\"]')", { what: 'the composer' });
      const before = app.fake.chatBodies.length;

      await page.clickVisible('[data-testid="mic-button"]');
      await page.waitFor("document.querySelector('#mic-button').classList.contains('is-recording')", { what: 'recording' });
      assert.equal(await page.ev("document.querySelector('[data-testid=\"send-button\"]').disabled"), false, 'Send is usable while recording');
      assert.equal(await page.ev("document.querySelector('[data-testid=\"send-button\"]').getAttribute('aria-label')"), 'Send voice message');

      await page.clickVisible('[data-testid="send-button"]');
      // The message is in the chat at once, with the recording on it; nothing sits in the tray.
      await page.waitFor("[...document.querySelectorAll('[data-testid=\"message-user\"]')].some((e) => /voice-.*\\.webm/.test(e.innerText))", { what: 'the voice message in the chat' });
      assert.equal(await page.ev("document.querySelector('#mic-button').classList.contains('is-recording')"), false, 'recording stopped');
      assert.equal(await page.ev("document.querySelector('#chips').hidden"), true, 'no chip in the tray');
      // The wait is a step of the reply.
      await page.waitFor("!!document.querySelector('[data-testid=\"working\"]') && document.querySelector('[data-testid=\"working\"]').innerText.includes('Transcribing voice message')", { what: 'the working line' });
      await page.waitFor("[...document.querySelectorAll('[data-testid=\"tool-row\"]')].some((e) => e.textContent.includes('Transcribing voice message') && e.dataset.status === 'running')", { what: 'a running Transcribing step' });
      assert.equal(app.fake.chatBodies.length, before, 'the agent is not called before the transcript exists');

      // The transcription finishes: the step is done and the agent is called with the recording.
      await page.waitFor('window.__transcribe.ids.length === 1', { what: 'the transcribe call' });
      const index = path.join(app.dataDir, 'uploads', `${await page.ev('window.__transcribe.ids[0]')}.json`);
      fs.writeFileSync(index, JSON.stringify({ ...JSON.parse(fs.readFileSync(index, 'utf8')), transcript: 'halo dari rekaman' }));
      await page.ev('window.__transcribe.release()');
      await page.waitFor(`document.querySelector('[data-testid="message-list"]')?.innerText.includes(${JSON.stringify(REPLY_TEXT)})`, { what: 'the reply', timeoutMs: 20_000 });
      assert.equal(app.fake.chatBodies.length, before + 1);
      assert.match(JSON.stringify(app.fake.chatBodies.at(-1).body.input), /halo dari rekaman/, 'the agent got the transcript');
      // When the turn settles, the chat shows what the server stored (the transcript on the message); the step is only for the wait.
      assert.equal(await page.ev("[...document.querySelectorAll('[data-testid=\"tool-row\"]')].some((e) => e.textContent.includes('Transcribing voice message') && e.dataset.status === 'running')"), false, 'the step is not left running');
      assert.equal(await page.ev('document.documentElement.scrollWidth <= window.innerWidth + 1'), true, 'no sideways scroll');
      assert.deepEqual(page.problems, [], 'no script errors or failed requests');
    });
  });
}
