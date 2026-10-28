// The Share button in the chat header opens a dialog with a per-link expiry; creating a link publishes through the (faked) share host.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, totp, TOTP_SECRET, USERNAME, PASSWORD } from '../helpers/boot.js';
import { findChrome, launchBrowser, VIEWPORTS } from './cdp.js';

const bin = findChrome();
const skip = bin ? false : 'no Chrome or Chromium found';
const SHOTS = process.env.UI_SHOTS_DIR || '';

describe('share dialog', { skip }, () => {
  let app;
  const puts = [];
  before(async () => {
    app = await boot({ inProcess: true, fake: { sessions: 2 }, files: { 'share.json': JSON.stringify({ baseUrl: 'https://share.example.test', accountId: 'a', namespaceId: 'n', apiToken: 'file:s.json#token' }), 's.json': '{"token":"x"}' } });
    const { setTransport } = await import('../../src/shares.js');
    setTransport(async (url, options) => { puts.push({ url, method: options.method }); return { status: 200, body: Buffer.from('{}') }; });
  });
  after(async () => { await app?.stop(); });

  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    test(`header button, expiry choice, create / refresh / stop (${name} ${viewport.width}x${viewport.height})`, async () => {
      const page = await launchBrowser(bin, { viewport });
      try {
        await page.navigate(`${app.base}/`);
        await page.waitFor("location.pathname === '/login.html'", { what: 'the login page' });
        await page.ev(`(() => { const f = document.querySelector('form'); const i = f.querySelectorAll('input');
          i[0].value = ${JSON.stringify(USERNAME)}; i[1].value = ${JSON.stringify(PASSWORD)}; i[2].value = ${JSON.stringify(totp(TOTP_SECRET))};
          f.requestSubmit(); })()`);
        await page.waitFor("location.pathname !== '/login.html'", { what: 'signed in' });
        await page.waitFor("document.querySelector('#model-chip')", { what: 'the app' });

        assert.equal(await page.ev("document.querySelector('#topbar-share').hidden"), true, 'hidden on a new chat');
        await page.waitFor("document.querySelector('.session-row')", { what: 'a chat in the list' });
        await page.ev("document.querySelector('.session-row').click()");
        await page.waitFor("!document.querySelector('#topbar-share').hidden", { what: 'the Share button' });

        await page.ev("document.querySelector('#topbar-share').click()");
        await page.waitFor("document.querySelector('[data-testid=share-publish]')", { what: 'the dialog form' });
        if (SHOTS) await page.screenshot(`${SHOTS}/${name}-share-dialog.png`);
        assert.equal(await page.ev('document.documentElement.scrollWidth <= window.innerWidth'), true, 'no sideways scroll');
        assert.equal(await page.ev("document.querySelector('[data-testid=share-hours]').closest('.dlg-row').hidden"), true, 'the hours field waits for Custom');
        await page.ev("document.querySelector('[data-testid=share-exp-168]').click()");
        await page.ev("document.querySelector('[data-testid=share-publish]').click()");
        await page.waitFor("document.querySelector('[data-testid=share-link]')", { what: 'the link' });
        assert.match(puts.at(-1).url, /expiration_ttl=604800/, 'the 1 week preset');
        await page.ev("document.querySelector('[data-testid=share-exp-custom]').click()");
        await page.ev("document.querySelector('[data-testid=share-hours]').value = '6'");
        assert.deepEqual(await page.ev("[...document.querySelectorAll('.share-field .seg .btn.selected')].map((b) => b.dataset.testid)"), ['share-exp-custom'], 'only Custom is selected');
        await new Promise((resolve) => setTimeout(resolve, 400)); // let the button colours finish their transition
        if (SHOTS) await page.screenshot(`${SHOTS}/${name}-share-custom.png`);
        const before = puts.length;
        await page.ev("document.querySelector('[data-testid=share-publish]').click()");
        for (let i = 0; i < 50 && puts.length === before; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
        assert.match(puts.at(-1).url, /expiration_ttl=21600/, 'custom hours');
        assert.match(await page.ev("document.querySelector('[data-testid=share-link]').value"), /^https:\/\/share\.example\.test\/[\w-]{43}$/);

        await page.ev("document.querySelector('[data-testid=share-exp-never]').click()");
        assert.equal(await page.ev("document.querySelector('[data-testid=share-hours]').closest('.dlg-row').hidden"), true);
        await page.ev("document.querySelector('[data-testid=share-publish]').click()");
        await page.waitFor("document.querySelector('[data-testid=share-status]')?.textContent.includes('Never')", { what: 'never expires' });
        assert.doesNotMatch(puts.at(-1).url, /expiration_ttl/);
        if (SHOTS) await page.screenshot(`${SHOTS}/${name}-share-dialog-created.png`);

        // reopening starts on the link's own expiry (never), not on the default
        await page.ev("document.querySelector('[aria-label=Close], .dlg .ibtn').click()");
        await page.ev("document.querySelector('#topbar-share').click()");
        await page.waitFor("document.querySelector('[data-testid=share-link]')", { what: 'the reopened dialog' });
        assert.deepEqual(await page.ev("[...document.querySelectorAll('.share-field .seg .btn.selected')].map((b) => b.dataset.testid)"), ['share-exp-never'], 'starts on the link\'s expiry');
        await page.ev("document.querySelector('[data-testid=share-stop]').click()");
        await page.waitFor("!document.querySelector('[data-testid=share-link]')", { what: 'the link to go' });
        // a new link starts on the last choice made (never)
        assert.deepEqual(await page.ev("[...document.querySelectorAll('.share-field .seg .btn.selected')].map((b) => b.dataset.testid)"), ['share-exp-never'], 'a new link starts on the last choice');
        assert.equal(puts.at(-1).method, 'DELETE');
      } finally {
        await page.close();
      }
    });
  }
});
