// Browser smoke tests: sign in, Feed home, Fresh timeline, story viewer, open a chat and send a message, home button and
// pull-to-refresh. They drive a locally installed Chrome or Chromium over the DevTools protocol (no npm dependencies) against the
// app, a fake Hermes agent and a seeded Fresh store, on a phone-sized and a desktop-sized viewport.
//
//   npm run test:ui            (CHROME_BIN=/path/to/chrome to choose the browser; the tests are skipped when none is found)
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { boot, totp, TOTP_SECRET, USERNAME, PASSWORD } from '../helpers/boot.js';
import { REPLY_TEXT } from '../fake-hermes/server.js';
import { findChrome, launchBrowser, VIEWPORTS } from './cdp.js';

const bin = findChrome();
const skip = bin ? false : 'no Chrome or Chromium found (install one, or set CHROME_BIN) - browser smoke tests skipped';
if (!bin) console.warn(`# ${skip}`);
const SHOTS = process.env.UI_SHOTS_DIR || '';

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  describe(`ui (${name} ${viewport.width}x${viewport.height})`, { skip }, () => {
    let app, page;
    const shot = (label) => (SHOTS ? page.screenshot(path.join(SHOTS, `${name}-${label}.png`)) : null);
    const count = (selector) => page.ev(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    const text = (selector) => page.ev(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
    const apiHits = (route) => (app.log().match(new RegExp(`^GET ${route} `, 'gm')) ?? []).length;
    const noSideways = () => page.ev('document.documentElement.scrollWidth <= window.innerWidth + 1');

    before(async () => {
      app = await boot({ seed: 40 });
      page = await launchBrowser(bin, { viewport });
    });
    after(async () => {
      await page?.close();
      await app?.stop();
    });

    test('an anonymous visitor is sent to the login page; a wrong code is refused; the right one signs in', async () => {
      await page.navigate(`${app.base}/`);
      await page.waitFor("location.pathname === '/login.html'", { what: 'redirect to the login page' });
      const submit = (code) => page.ev(`(() => { const f = document.querySelector('form'); const i = f.querySelectorAll('input'); i[0].value = ${JSON.stringify(USERNAME)}; i[1].value = ${JSON.stringify(PASSWORD)}; i[2].value = ${JSON.stringify(code)}; f.requestSubmit(); })()`);
      await submit('000000');
      await page.waitFor("(() => { const e = document.querySelector('#login-error'); return !!e && !e.hidden && e.textContent.trim().length > 0; })()", { what: 'an error message' });
      assert.equal(await page.ev("location.pathname"), '/login.html');
      await shot('login-error');
      await submit(totp(TOTP_SECRET));
      await page.waitFor("!!document.querySelector('[data-testid=\"feed-home\"]')", { what: 'the Feed home after sign-in' });
      assert.equal(await page.ev("document.documentElement.dataset.feedView"), 'home');
    });

    test('Feed home renders chats as stories and the Fresh timeline as cards, without sideways scrolling', async () => {
      await page.waitFor("document.querySelectorAll('.fh-story[data-id]').length >= 5", { what: 'story circles' });
      await page.waitFor("document.querySelectorAll('.fr-card').length >= 5", { what: 'Fresh cards' });
      assert.match(await text('.fr-card .fr-title'), /^Card title \d+/);
      assert.ok(await noSideways(), 'the page must not scroll sideways');
      assert.equal(await page.ev("[...document.querySelectorAll('.fr-card img')].filter((i) => i.complete && i.naturalWidth === 0).length"), 0, 'no broken card pictures');
      await shot('home');
    });

    test('Fresh: Latest orders by time, a category narrows the list, scrolling loads more cards', async () => {
      await page.click('.fr-mode-btn[data-mode="latest"]');
      await page.waitFor("document.querySelector('.fr-mode-btn[data-mode=\"latest\"]').getAttribute('aria-pressed') === 'true'", { what: 'latest mode' });
      await page.waitFor("document.querySelector('.fr-card .fr-title')?.innerText === 'Card title 0'", { what: 'the newest card first' });
      const first = await count('.fr-card');
      assert.ok(first >= 5 && first <= 20, `first page has ${first} cards`);
      await page.ev("(() => { const s = document.querySelector('.fh-scroll'); s.scrollTop = s.scrollHeight; })()");
      await page.waitFor(`document.querySelectorAll('.fr-card').length > ${first}`, { what: 'the next page of cards' });
      await page.ev("document.querySelector('.fh-scroll').scrollTop = 0");
      await page.click('.fr-chip[data-cat="security"]');
      await page.waitFor("[...document.querySelectorAll('.fr-card .fr-cat')].length > 0 && document.querySelectorAll('.fr-card').length < 20", { what: 'the security category' });
      const cats = await page.ev("[...new Set([...document.querySelectorAll('.fr-card .fr-cat')].map((e) => e.innerText.trim()))].length");
      assert.equal(cats, 1, 'only one category is shown');
      await page.click('.fr-chip[data-cat=""], .fr-chip:first-child');
      await page.click('.fr-mode-btn[data-mode="foryou"]');
      await shot('timeline');
    });

    test('opening a story shows a preview of that chat, and Escape closes it', async () => {
      await page.ev("document.querySelector('.fh-scroll').scrollTop = 0");
      await page.clickVisible('.fh-story[data-id]:not([data-id=""])');
      await page.waitFor("!!document.querySelector('[data-testid=\"story-viewer\"]')", { what: 'the story viewer' });
      await page.waitFor("/Please explain|A short answer/.test(document.querySelector('[data-testid=\"story-viewer\"]').innerText)", { what: 'the chat preview text' });
      await shot('story');
      await page.press('Escape');
      await page.waitFor("!document.querySelector('[data-testid=\"story-viewer\"]')", { what: 'the viewer to close' });
    });

    test('a chat opens from a story and a message gets the fake agent\'s streamed reply', async () => {
      await page.clickVisible('.fh-story[data-id]:not([data-id=""])');
      await page.click('[data-testid="story-open"]');
      await page.waitFor("!!document.querySelector('[data-testid=\"composer-input\"]') && document.documentElement.dataset.feedView === 'chat'", { what: 'the chat view' });
      const before = app.fake.chatBodies.length;
      await page.setValue('[data-testid="composer-input"]', 'Hello from the browser test');
      await page.clickVisible('[data-testid="send-button"]');
      await page.waitFor(`document.querySelector('[data-testid="message-list"]')?.innerText.includes(${JSON.stringify(REPLY_TEXT)})`, { what: 'the streamed reply', timeoutMs: 20_000 });
      assert.equal(app.fake.chatBodies.length, before + 1);
      assert.equal(app.fake.chatBodies.at(-1).body.input, 'Hello from the browser test');
      assert.match(await text('[data-testid="message-list"]'), /Hello from the browser test/);
      await shot('chat');
    });

    test('going back from a chat shows the Feed home; the home button scrolls to the top and refreshes', async () => {
      // On a phone the tab bar is hidden inside a chat and the system Back gesture is the way out; on a desktop the left column stays.
      if (viewport.mobile) await page.ev('history.back()');
      else await page.clickVisible('[data-testid="feed-side"] .feed-side-item');
      await page.waitFor("document.documentElement.dataset.feedView === 'home' && !!document.querySelector('.fr-card')", { what: 'the home view' });
      assert.ok(await noSideways());
      await page.ev("(() => { const s = document.querySelector('.fh-scroll'); s.scrollTop = 600; })()");
      await page.waitFor("document.querySelector('.fh-scroll').scrollTop > 100", { what: 'the feed to scroll down' });
      const before = apiHits('/api/fresh');
      await page.clickVisible(viewport.mobile ? '[data-testid="feed-nav"] .feed-tab' : '[data-testid="feed-side"] .feed-side-item');
      await page.waitFor("document.querySelector('.fh-scroll').scrollTop < 5", { what: 'the feed to scroll back to the top' });
      const deadline = Date.now() + 10_000;
      while (apiHits('/api/fresh') <= before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(apiHits('/api/fresh') > before, 'the Fresh timeline was requested again');
      await shot('home-again');
    });

    test('pull down to refresh looks for new chats and cards again (touch only)', { skip: viewport.touch ? false : 'pull-to-refresh is a touch gesture' }, async () => {
      await page.ev("document.querySelector('.fh-scroll').scrollTop = 0");
      const before = apiHits('/api/fresh');
      assert.equal(await page.ev("matchMedia('(pointer: coarse)').matches"), true, 'touch emulation is on');
      // Start the drag on the timeline's mode switch: the story row has its own horizontal scrolling and does not start a pull.
      const box = await page.box('.fr-mode');
      await page.drag(box.x, box.y, 320);
      const deadline = Date.now() + 10_000;
      while (apiHits('/api/fresh') <= before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(apiHits('/api/fresh') > before, 'the timeline was requested again');
      assert.ok(await count('.fr-card') >= 5);
    });

    test('the browser reported no script errors or failed requests', async () => {
      // The wrong sign-in code in the first test is refused with a 401 on purpose.
      const unexpected = page.problems.filter((p) => !/401 \(Unauthorized\).*\/api\/login/.test(p));
      assert.deepEqual(unexpected, []);
    });
  });
}
