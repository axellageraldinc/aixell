// While the agent is still working the voice chat speaks short filler phrases: one right away, more at the marks, and none once
// the answer starts. The marks are set to 1 and 2 seconds in a custom data/voice-fillers.json and the fake agent is slow, so the
// whole timeline runs in a few seconds. The speech provider is a local fake; nothing here reaches a real service.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { boot, totp, TOTP_SECRET, USERNAME, PASSWORD } from '../helpers/boot.js';
import { REPLY_TEXT } from '../fake-hermes/server.js';
import { startFakeGateway, GW_KEY } from '../helpers/fake-gateway.js';
import { findChrome, launchBrowser, VIEWPORTS } from './cdp.js';
import { FAKES, wav } from './voice-fakes.js';

const bin = findChrome();
const skip = bin ? false : 'no Chrome or Chromium found';
const FILLERS = { start: ['Hold on one moment.'], waits: [{ at: [1, 2], phrases: ['Still on it one.', 'Still on it two.'] }] };

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  describe(`voice chat fillers (${name} ${viewport.width}x${viewport.height})`, { skip }, () => {
    let app, page, gw;
    before(async () => {
      gw = await startFakeGateway();
      gw.handlers['POST /audio/speech'] = () => ({ status: 200, headers: { 'Content-Type': 'audio/wav' }, raw: wav(0.6) });
      const providers = {
        providers: { gw: { type: 'openai-compatible', baseUrl: gw.url, apiKey: 'env:HW_VOICE_KEY' } },
        capabilities: { speech: { provider: 'gw', model: 'tts-test', voice: 'v1' } },
      };
      // 1.5 s between the stream's frames: the first words of the answer come after about 3 s.
      app = await boot({ fake: { sessions: 2, replyDelayMs: 1500 }, env: { HW_VOICE_KEY: GW_KEY },
        files: { 'providers.json': JSON.stringify(providers), 'voice-fillers.json': JSON.stringify(FILLERS) } });
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

    test('a filler is spoken at once, another at the mark, and none after the answer starts', async () => {
      await page.waitFor("document.querySelector('.session-row')", { what: 'a chat in the list' });
      await page.ev("document.querySelector('.session-row').click()");
      await page.waitFor("document.querySelector('#voice-button') && !document.querySelector('#voice-button').hidden", { what: 'the voice button' });
      await page.clickVisible('[data-testid="voice-button"]');
      await page.waitFor("!!document.querySelector('[data-testid=\"voice-overlay\"]')", { what: 'the overlay' });
      // The first phrase is requested as soon as the overlay opens, before anyone has spoken.
      const inputs = () => gw.requests.filter((r) => r.path === '/audio/speech').map((r) => r.body.input);
      for (let i = 0; i < 50 && !inputs().includes('Hold on one moment.'); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(inputs().includes('Hold on one moment.'), 'the start phrase was prepared ahead');

      await page.clickVisible('[data-testid="voice-orb"]');
      await page.waitFor("document.querySelector('[data-testid=\"voice-orb\"]').dataset.state === 'recording'", { what: 'recording' });
      await new Promise((resolve) => setTimeout(resolve, 800));
      await page.clickVisible('[data-testid="voice-orb"]');

      await page.waitFor(`document.querySelector('[data-testid="voice-filler"]')?.textContent === 'Hold on one moment.'`, { what: 'the first filler', timeoutMs: 10_000 });
      await page.screenshot(path.join(os.tmpdir(), `voice-filler-${name}.png`));
      assert.equal(await page.ev("document.querySelector('[data-testid=\"voice-orb\"]').dataset.state"), 'thinking');
      await page.waitFor(`/^Still on it (one|two)\\.$/.test(document.querySelector('[data-testid="voice-filler"]')?.textContent ?? '')`, { what: 'a filler at a mark', timeoutMs: 10_000 });
      assert.equal(await page.ev("document.querySelectorAll('.voice-filler').length"), 1, 'one filler line at a time');

      // The answer starts: the filler line goes away and the words are shown.
      await page.waitFor("document.querySelectorAll('.voice-reply .w').length > 0", { what: 'the reply words', timeoutMs: 40_000 });
      assert.equal(await page.ev("!!document.querySelector('.voice-filler')"), false, 'no filler line once the answer is shown');
      const marks = inputs().filter((text) => text.startsWith('Still on it'));
      assert.ok(marks.length >= 1 && marks.length <= 2, `fillers requested for the marks: ${marks.join(', ')}`);
      assert.notEqual(marks[0], marks[1], 'the same filler is not repeated');
      await page.waitFor("document.querySelector('[data-testid=\"voice-orb\"]').dataset.state === 'idle'", { what: 'idle after speaking', timeoutMs: 40_000 });
      assert.equal(inputs().filter((text) => text === REPLY_TEXT).length, 1);
      assert.equal(await page.ev('document.documentElement.scrollWidth <= window.innerWidth + 1'), true, 'no sideways scroll');
      assert.deepEqual(page.problems, [], 'no script errors or failed requests');
    });
  });
}
