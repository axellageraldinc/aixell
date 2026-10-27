// Drives the real UI in headless Chrome against the app booted with a ROUTED catalog provider (like xellter):
// the composer's model popover must show the routing note instead of a model list, while Visualize stays, and the
// chip must name the real model the gateway pinned for the open conversation.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, totp, TOTP_SECRET, USERNAME, PASSWORD } from '../helpers/boot.js';
import { startFakeGateway, GW_KEY } from '../helpers/fake-gateway.js';
import { findChrome, launchBrowser, VIEWPORTS } from './cdp.js';

const bin = findChrome();
const skip = bin ? false : 'no Chrome or Chromium found';
const SHOTS = process.env.UI_SHOTS_DIR || '';
const SERVED = 'served-model-free';

// A routed catalog provider. The gateway only has to answer the served-model question: the model list is never read.
const routedProviders = (baseUrl) => JSON.stringify({
  providers: { routed: { type: 'openai-compatible', baseUrl, apiKey: 'env:HW_ROUTE_KEY' } },
  capabilities: { models: { provider: 'routed', routed: true, servedModelPath: '/session' } },
});

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  describe(`routed model picker (${name} ${viewport.width}x${viewport.height})`, { skip }, () => {
    let app, gw, page;
    before(async () => {
      gw = await startFakeGateway();
      gw.handlers['GET /session'] = () => ({ status: 200, body: { object: 'session', model: SERVED, last_model: SERVED, models: [SERVED] } });
      // Seeded chats: opening one is what makes the app ask the gateway for the model behind it.
      app = await boot({ seed: 12, files: { 'providers.json': routedProviders(gw.url) }, env: { HW_ROUTE_KEY: GW_KEY } });
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
      await gw?.close();
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

    test('opening a chat names the real model the gateway pinned, beside the route', async () => {
      // Close the popover from the previous test (the composer's own click-outside path).
      await page.waitFor(`(() => {
        const chip = document.querySelector('#model-chip');
        if (chip.getAttribute('aria-expanded') !== 'true') return true;
        chip.click();
        return chip.getAttribute('aria-expanded') !== 'true';
      })()`, { what: 'the popover to close' });
      // A chat opens from a story circle, on both viewports (the same path the smoke test uses).
      await page.clickVisible('.fh-story[data-id]:not([data-id=""])');
      await page.click('[data-testid="story-open"]');
      await page.waitFor("document.documentElement.dataset.feedView === 'chat'", { what: 'the chat view' });
      const expected = `fake-model - ${SERVED}`;
      await page.waitFor(`document.querySelector('#model-chip-text')?.textContent.trim() === ${JSON.stringify(expected)}`, { timeoutMs: 15_000, what: 'the chip to name the served model' });
      if (SHOTS) await page.screenshot(`${SHOTS}/${name}-routed-chip.png`);
      assert.equal(await page.ev('document.documentElement.scrollWidth <= window.innerWidth + 1'), true, 'no sideways scrolling');
      assert.deepEqual(page.problems, [], 'no script errors or failed requests');

      // A phone truncates the chip; the popover still spells the whole name out.
      await page.clickVisible('#model-chip');
      await page.waitFor("document.querySelector('#model-popover').innerText.trim().length > 0", { what: 'popover content' });
      assert.match(await page.ev("document.querySelector('[data-testid=model-served]')?.innerText ?? ''"), new RegExp(SERVED));
      assert.deepEqual(page.problems, [], 'no script errors or failed requests');
    });
  });
}