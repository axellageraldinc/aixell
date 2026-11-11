// Drives the real UI against an app with two model sources (a routed gateway and a fixed list): the popover shows one group
// per source with an "Auto" row and real models, picking a model updates the chip, and nothing scrolls sideways.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, totp, TOTP_SECRET, USERNAME, PASSWORD } from '../helpers/boot.js';
import { startFakeGateway, GW_KEY } from '../helpers/fake-gateway.js';
import { findChrome, launchBrowser, VIEWPORTS } from './cdp.js';

const bin = findChrome();
const skip = bin ? false : 'no Chrome or Chromium found';
const SHOTS = process.env.UI_SHOTS_DIR || '';

const providersJson = (baseUrl) => JSON.stringify({
  providers: { routed: { type: 'openai-compatible', baseUrl, apiKey: 'env:HW_ROUTE_KEY' } },
  capabilities: { models: { sources: [
    { provider: 'routed', hermesProvider: 'route-h', routed: true, model: 'auto', label: 'Gateway' },
    { hermesProvider: 'fixed-h', models: ['fx-alpha', 'fx-beta'], label: 'Mine' },
  ] } },
});

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  describe(`model sources picker (${name} ${viewport.width}x${viewport.height})`, { skip }, () => {
    let app, gw, page;
    before(async () => {
      gw = await startFakeGateway();
      app = await boot({ seed: 12, files: { 'providers.json': providersJson(gw.url) }, env: { HW_ROUTE_KEY: GW_KEY } });
      page = await launchBrowser(bin, { viewport });
      await page.navigate(`${app.base}/`);
      await page.waitFor("location.pathname === '/login.html'", { what: 'the login page' });
      const code = totp(TOTP_SECRET);
      await page.ev(`(() => { const f = document.querySelector('form'); const i = f.querySelectorAll('input');
        i[0].value = ${JSON.stringify(USERNAME)}; i[1].value = ${JSON.stringify(PASSWORD)}; i[2].value = ${JSON.stringify(code)};
        f.requestSubmit(); })()`);
      await page.waitFor("location.pathname !== '/login.html'", { what: 'signed in' });
      await page.waitFor("document.querySelector('#model-chip')", { what: 'the composer' });
    });
    after(async () => { await page?.close(); await app?.stop(); await gw?.close(); });

    test('groups per source, picking a model changes the chip', async () => {
      await page.waitFor(`(() => {
        const chip = document.querySelector('#model-chip');
        if (chip.getAttribute('aria-expanded') === 'true') return true;
        chip.click();
        return chip.getAttribute('aria-expanded') === 'true';
      })()`, { what: 'the popover to open' });
      await page.waitFor("document.querySelectorAll('#model-popover [data-testid=model-option]').length >= 3", { what: 'the model rows' });
      const info = await page.ev(`(() => {
        const pop = document.querySelector('#model-popover');
        return {
          groups: [...pop.querySelectorAll('[data-testid=model-group]')].map((g) => g.textContent.trim()),
          options: [...pop.querySelectorAll('[data-testid=model-option]')].map((o) => o.dataset.provider + '/' + o.dataset.model),
          auto: pop.querySelector('[data-testid=model-option]').innerText.includes('Auto'),
        };
      })()`);
      if (SHOTS) await page.screenshot(`${SHOTS}/${name}-sources-popover.png`);
      assert.deepEqual(info.groups, ['Gateway', 'Mine']);
      assert.deepEqual(info.options, ['route-h/auto', 'fixed-h/fx-alpha', 'fixed-h/fx-beta']);
      assert.equal(info.auto, true, 'the routed source is one Auto row');
      assert.equal(await page.ev('document.documentElement.scrollWidth <= window.innerWidth + 1'), true, 'no sideways scrolling');

      await page.ev("document.querySelector('#model-popover [data-model=fx-beta] [data-testid=model-option], #model-popover [data-testid=model-option][data-model=fx-beta]').click()");
      await page.waitFor("document.querySelector('#model-chip-text').textContent.includes('fx-beta')", { what: 'the chip to show the pick' });
      assert.deepEqual(page.problems, [], 'no script errors or failed requests');
    });
  });
}
