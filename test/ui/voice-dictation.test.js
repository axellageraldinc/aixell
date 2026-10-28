// With the Settings mic mode on Dictation the voice chat does not record: the words appear as they are said (the browser's
// speech recognition, faked here), and a tap sends them to the agent with no upload and no server transcription. The speech
// provider is a local fake; nothing here reaches a real service.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { boot, totp, TOTP_SECRET, USERNAME, PASSWORD } from '../helpers/boot.js';
import { REPLY_TEXT } from '../fake-hermes/server.js';
import { startFakeGateway, GW_KEY } from '../helpers/fake-gateway.js';
import { findChrome, launchBrowser, VIEWPORTS } from './cdp.js';
import { FAKES, DICTATION_FAKES, wav } from './voice-fakes.js';

const bin = findChrome();
const skip = bin ? false : 'no Chrome or Chromium found';

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  describe(`voice chat dictation (${name} ${viewport.width}x${viewport.height})`, { skip }, () => {
    let app, page, gw;
    before(async () => {
      gw = await startFakeGateway();
      gw.handlers['POST /audio/speech'] = () => ({ status: 200, headers: { 'Content-Type': 'audio/wav' }, raw: wav(0.6) });
      const providers = {
        providers: { gw: { type: 'openai-compatible', baseUrl: gw.url, apiKey: 'env:HW_VOICE_KEY' } },
        capabilities: { speech: { provider: 'gw', model: 'tts-test', voice: 'v1' } },
      };
      app = await boot({ fake: { sessions: 2 }, env: { HW_VOICE_KEY: GW_KEY }, files: { 'providers.json': JSON.stringify(providers) } });
      page = await launchBrowser(bin, { viewport });
      await page.addInitScript(FAKES);
      await page.addInitScript(DICTATION_FAKES);
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

    test('talk by dictation: live words, one tap to send, no upload', async () => {
      await page.waitFor("document.querySelector('.session-row')", { what: 'a chat in the list' });
      await page.ev("document.querySelector('.session-row').click()");
      await page.waitFor("document.querySelector('#voice-button') && !document.querySelector('#voice-button').hidden", { what: 'the voice button' });
      const before = app.fake.chatBodies.length;
      await page.clickVisible('[data-testid="voice-button"]');
      await page.waitFor("!!document.querySelector('[data-testid=\"voice-overlay\"]')", { what: 'the overlay' });

      await page.clickVisible('[data-testid="voice-orb"]');
      await page.waitFor("document.querySelector('[data-testid=\"voice-orb\"]').dataset.state === 'recording'", { what: 'listening' });
      // The words appear while they are being said, before anything is sent.
      await page.waitFor(`document.querySelector('[data-testid="voice-you"]').textContent === 'halo dunia'`, { what: 'the live words', timeoutMs: 5000 });
      await page.screenshot(path.join(os.tmpdir(), `voice-dictation-${name}.png`));
      assert.equal(app.fake.chatBodies.length, before, 'nothing is sent until the tap');
      await page.clickVisible('[data-testid="voice-orb"]');

      await page.waitFor("document.querySelectorAll('.voice-reply .w').length > 0", { what: 'the reply words', timeoutMs: 20_000 });
      assert.equal(app.fake.chatBodies.at(-1).body.input, 'halo dunia', 'what was dictated went to the agent');
      assert.equal(await page.ev("document.querySelector('[data-testid=\"voice-you\"]').textContent"), 'halo dunia');
      assert.equal(await page.ev('window.__dictation.started'), 1, 'one recognition session');
      assert.equal(await page.ev("performance.getEntriesByType('resource').filter((e) => /\\/uploads/.test(e.name)).length"), 0, 'no audio was uploaded');
      assert.equal(await page.ev("[...document.querySelectorAll('.voice-reply .w')].map((w) => w.textContent).join(' ')"), REPLY_TEXT);
      await page.waitFor("document.querySelector('[data-testid=\"voice-orb\"]').dataset.state === 'idle'", { what: 'idle after speaking', timeoutMs: 30_000 });
      assert.deepEqual(page.problems, [], 'no script errors or failed requests');
    });
  });
}
