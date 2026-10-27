// The effort the owner picks in the settings panel must reach the agent.
//
// The owner's case: the default effort of a routed agent (xellter) was set to "none" in the dashboard, and the answer came
// back after nine minutes with 46,773 output tokens. The effort was dropped in the browser, because a routed catalogue
// has no reasoning flag on its route entry and the client only sent an effort for a model that could think.
//
// A routed agent has no effort control in the model popover (there is no model list to choose from), so the default effort
// of the agent is the only way to set it. This test drives the real browser against a routed provider and checks the body
// that reaches the agent.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, totp, TOTP_SECRET, USERNAME, PASSWORD, AGENT_NAME } from '../helpers/boot.js';
import { startFakeGateway, GW_KEY } from '../helpers/fake-gateway.js';
import { findChrome, launchBrowser, VIEWPORTS } from './cdp.js';

const bin = findChrome();
const skip = bin ? false : 'no Chrome or Chromium found';
const SERVED = 'served-model-free';

// A routed catalog provider, like xellter: the gateway resolves the real model per request.
const routedProviders = (baseUrl) => JSON.stringify({
  providers: { routed: { type: 'openai-compatible', baseUrl, apiKey: 'env:HW_ROUTE_KEY' } },
  capabilities: { models: { provider: 'routed', routed: true, servedModelPath: '/session' } },
});

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  describe(`the effort of a routed agent (${name} ${viewport.width}x${viewport.height})`, { skip }, () => {
    let app, gw, page;
    before(async () => {
      gw = await startFakeGateway();
      gw.handlers['GET /session'] = () => ({ status: 200, body: { object: 'session', model: SERVED, last_model: SERVED, models: [SERVED] } });
      app = await boot({ seed: 12, files: { 'providers.json': routedProviders(gw.url) }, env: { HW_ROUTE_KEY: GW_KEY } });

      // The owner sets the default effort in the dashboard, before the page asks for the catalogue.
      const me = await app.login();
      const settings = await me.put(`/api/agents/${AGENT_NAME}/settings`, { defaultEffort: 'none' });
      assert.equal(settings.status, 200, JSON.stringify(settings.data));
      assert.equal(settings.data.defaults.effort, 'none', 'the effort was saved');

      page = await launchBrowser(bin, { viewport });
      await page.navigate(`${app.base}/`);
      await page.waitFor("location.pathname === '/login.html'", { what: 'the login page' });
      const code = totp(TOTP_SECRET);
      await page.ev(`(() => { const f = document.querySelector('form'); const i = f.querySelectorAll('input');
        i[0].value = ${JSON.stringify(USERNAME)}; i[1].value = ${JSON.stringify(PASSWORD)}; i[2].value = ${JSON.stringify(code)};
        f.requestSubmit(); })()`);
      await page.waitFor("location.pathname !== '/login.html'", { what: 'signed in' });
      await page.waitFor("!!document.querySelector('[data-testid=\"feed-home\"]')", { what: 'the Feed home' });
    });
    after(async () => {
      await page?.close();
      await app?.stop();
      await gw?.close();
    });

    test('the default effort of the agent reaches the agent', async () => {
      // A chat opens from a story circle, on both viewports (the same path the smoke test uses).
      await page.clickVisible('.fh-story[data-id]:not([data-id=""])');
      await page.click('[data-testid="story-open"]');
      await page.waitFor("document.documentElement.dataset.feedView === 'chat'", { what: 'the chat view' });
      await page.waitFor("!!document.querySelector('[data-testid=\"composer-input\"]')", { what: 'the composer' });

      const before = app.fake.chatBodies.length;
      await page.setValue('[data-testid="composer-input"]', 'Hello routed agent');
      await page.clickVisible('[data-testid="send-button"]');
      // The page shows the message at once; the agent is called a moment later.
      const deadline = Date.now() + 20_000;
      while (app.fake.chatBodies.length <= before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(app.fake.chatBodies.length > before, 'the agent was called');

      const forwarded = app.fake.chatBodies.at(-1);
      assert.deepEqual(forwarded.body.model_options, { reasoning_effort: 'none' },
        'the default effort of a routed agent must reach the agent');
      assert.deepEqual(page.problems, [], 'no script errors or failed requests');
    });
  });
}
