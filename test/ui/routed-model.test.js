// Drives the real UI in headless Chrome against the app booted with a ROUTED catalog provider (like xellter):
// the composer's model popover must show the routing note instead of a model list, while Visualize stays.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, totp, TOTP_SECRET, USERNAME, PASSWORD } from '../helpers/boot.js';
import { findChrome, launchBrowser, VIEWPORTS } from './cdp.js';

const bin = findChrome();
const skip = bin ? false : 'no Chrome or Chromium found';
const SHOTS = process.env.UI_SHOTS_DIR || '';

// A routed catalog provider: /models is never consulted for the list, so a missing endpoint is fine.
const ROUTED_PROVIDERS = JSON.stringify({
  providers: { routed: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'agentEnv:FAKE_ROUTE_KEY' } },
  capabilities: { models: { provider: 'routed', routed: true } },
});

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  describe(`routed model picker (${name} ${viewport.width}x${viewport.height})`, { skip }, () => {
    let app, page;
    before(async () => {
      app = await boot({ files: { 'providers.json': ROUTED_PROVIDERS } });
      page = await launchBrowser(bin, { viewport });
      await page.navigate(`${app.base}/`);
      await page.waitFor("location.pathname === '/login.html'", { what: 'the login page' });
      const code = totp(TOTP_SECRET);
      await page.ev(`(() => { const f = document.querySelector('form'); const i = f.querySelectorAll('input');
        i[0].value = ${JSON.stringify(USERNAME)}; i[1].value = ${JSON.stringify(PASSWORD)}; i[2].value = ${JSON.stringify(code)};
        f.requestSubmit(); })()`);
      await page.waitFor("location.pathname !== '/login.html'", { what: 'signed in' });
      // the app boots its modules after sign-in; the composer is the last of them
      await page.waitFor("document.querySelector('#model-chip')", { what: 'the composer' });
    });
    after(async () => {
      await page?.close();
      await app?.stop();
    });

    test('the popover offers no model list, keeps Visualize, and does not scroll sideways', async () => {
      await page.waitFor("document.querySelector('#model-chip')", { what: 'the model chip' });
      // The chip exists before its popover is bound (composer init runs last), so click until it opens.
      await page.waitFor(`(() => {
        const chip = document.querySelector('#model-chip');
        if (chip.getAttribute('aria-expanded') === 'true') return true;
        chip.click();
        return chip.getAttribute('aria-expanded') === 'true';
      })()`, { what: 'the popover to open' });
      await page.waitFor("document.querySelector('#model-popover').innerText.trim().length > 0", { what: 'popover content' });

      const info = await page.ev(`(() => {
        const pop = document.querySelector('#model-popover');
        return {
          routed: !!pop.querySelector('[data-testid=model-routed]'),
          options: pop.querySelectorAll('[data-testid=model-option]').length,
          search: !!pop.querySelector('input[type=search]'),
          effort: !!pop.querySelector('[data-testid=effort-option]'),
          speed: !!pop.querySelector('[data-testid=speed-option]'),
          visualize: !!pop.querySelector('[data-testid=visualize-toggle]'),
        };
      })()`);
      if (SHOTS) await page.screenshot(`${SHOTS}/${name}-routed-popover.png`);

      assert.equal(info.routed, true, 'the routing note is shown');
      assert.equal(info.options, 0, 'no model rows are offered');
      assert.equal(info.search, false, 'no model search box');
      assert.equal(info.effort, false, 'effort is gone: the gateway picks the model, not the effort');
      assert.equal(info.speed, false, 'speed is gone for the same reason');
      assert.equal(info.visualize, true, 'Visualize stays');
      assert.equal(await page.ev('document.documentElement.scrollWidth <= window.innerWidth + 1'), true, 'no sideways scrolling');
      assert.deepEqual(page.problems, [], 'no script errors or failed requests');
    });
  });
}
