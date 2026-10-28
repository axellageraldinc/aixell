// The shared-chat snapshot is built in the browser: hostile markup must come out inert, and a normal reply must keep its shape.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, totp, TOTP_SECRET, USERNAME, PASSWORD } from '../helpers/boot.js';
import { findChrome, launchBrowser, VIEWPORTS } from './cdp.js';

const bin = findChrome();
const skip = bin ? false : 'no Chrome or Chromium found';

describe('shared chat snapshot', { skip }, () => {
  let app, page;
  before(async () => {
    app = await boot();
    page = await launchBrowser(bin, { viewport: VIEWPORTS.desktop ?? Object.values(VIEWPORTS)[0] });
    await page.navigate(`${app.base}/`);
    await page.waitFor("location.pathname === '/login.html'", { what: 'the login page' });
    await page.ev(`(() => { const f = document.querySelector('form'); const i = f.querySelectorAll('input');
      i[0].value = ${JSON.stringify(USERNAME)}; i[1].value = ${JSON.stringify(PASSWORD)}; i[2].value = ${JSON.stringify(totp(TOTP_SECRET))};
      f.requestSubmit(); })()`);
    await page.waitFor("location.pathname !== '/login.html'", { what: 'signed in' });
    await page.waitFor("document.querySelector('#model-chip')", { what: 'the app' });
  });
  after(async () => { await page?.close(); await app?.stop(); });

  test('scripts, handlers, remote images, forms and buttons are gone; text, code and safe links stay', async () => {
    const out = await page.ev(`(async () => {
      const { snapshotHtml } = await import('/lib/share-chat.js');
      return snapshotHtml([
        { role: 'user', content: 'hello <b>there</b>\\n[Attachment: a.png (image, image/png) saved at /x/webup_${'a'.repeat(24)}_a.png]', timestamp: 1 },
        { role: 'assistant', content: 'Reply with **bold**, \`code\`, [ok](https://example.org/p), [bad](javascript:alert(1)) and ![pic](https://evil.test/x.png)\\n\\n<script>alert(1)</script><img src=x onerror=alert(1)>', timestamp: 2 },
      ]);
    })()`);
    assert.match(out, /hello/);
    assert.match(out, /<strong>bold<\/strong>/);
    assert.match(out, /<code>code<\/code>/);
    assert.match(out, /href="https:\/\/example\.org\/p"/);
    assert.match(out, /Attachment: a\.png/);
    for (const bad of [/<script/i, /<img/i, /<[^>]*\son\w+=/i, /href="javascript/i, /<button/i, /<form/i, /<input/i, /\/api\/uploads/i]) assert.doesNotMatch(out, bad, `${bad}: ${out}`);
  });
});
