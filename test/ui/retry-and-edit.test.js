// Two chat details in the real UI: a user bubble keeps the exact text for editing (every paragraph, not just the first),
// and a waiting reply can show what the agent is retrying.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, totp, TOTP_SECRET, USERNAME, PASSWORD } from '../helpers/boot.js';
import { findChrome, launchBrowser, VIEWPORTS } from './cdp.js';

const bin = findChrome();
const skip = bin ? false : 'no Chrome or Chromium found';

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  describe(`retry note and edit text (${name})`, { skip }, () => {
    let app, page;
    before(async () => {
      app = await boot({ seed: 3 });
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
    after(async () => { await page?.close(); await app?.stop(); });

    test('a multi-paragraph message keeps its full text for editing', async () => {
      const raw = await page.ev(`(async () => {
        const { userNode } = await import('/lib/message-nodes.js');
        const text = 'first paragraph\\n\\nsecond paragraph\\n\\n- item a\\n- item b';
        return { raw: userNode(text, null).querySelector('.user-body').dataset.raw, expected: text };
      })()`);
      assert.equal(raw.raw, raw.expected);
    });

    test('a retry note appears with the reason and clears', async () => {
      const result = await page.ev(`(async () => {
        const { createAssistantMessage } = await import('/lib/stream-message.js');
        const m = createAssistantMessage();
        document.body.append(m.node);
        const note = m.node.querySelector('[data-testid=retry-note]');
        const hidden0 = note.hidden;
        m.setRetry({ attempt: 2, max: 3, waitSeconds: 30, model: 'x', reason: 'HTTP 503: upstream unavailable', recovery: null });
        const shown = { hidden: note.hidden, text: note.textContent };
        m.setRetry(null);
        const out = { hidden0, shown, hiddenAfter: note.hidden };
        m.node.remove();
        return out;
      })()`);
      assert.equal(result.hidden0, true);
      assert.equal(result.shown.hidden, false);
      assert.match(result.shown.text, /HTTP 503: upstream unavailable.*30s.*attempt 2 of 3/);
      assert.equal(result.hiddenAfter, true);
      assert.deepEqual(page.problems, []);
    });
  });
}
