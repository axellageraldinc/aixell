// Language-agnostic pipeline (P5d): with the content language set to German, the writer prompt that
// reaches the provider says so and carries none of the marker words of another language. The
// gateway is the local fake; no network and no paid API is involved.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRY_NAMES, REPO_WORDS, REPO_WORDS_RE } from '../helpers/indonesian.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../helpers/env.js';
import { startFakeGateway, startGateway, GW_KEY } from '../helpers/fake-gateway.js';

process.env.HERMES_WEB_FRESH_OFFLINE = '0';

const { config } = await import('../../src/config.js');
const llm = await import('../../src/fresh/llm.js');
const store = await import('../../src/fresh/store.js');
const rl = await import('../../src/providers/ratelimit.js');
const compat = await import('../../src/providers/compat.js');

const FREE = 'deepseek-v4-1-flash:free';
const MARKERS = [...COUNTRY_NAMES, ...REPO_WORDS];

const agentOf = (baseUrl) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-lang-'));
  fs.writeFileSync(path.join(home, '.env'), `GATEWAY_API_KEY=${GW_KEY}\n`);
  process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
  return { name: `lang-${Math.random().toString(36).slice(2, 8)}`, home, provider: 'gateway', model: 'chat-a', baseUrl };
};

const batch = () => [{ id: 'a1', title: 'A new model is out', sourceName: 'Example', text: 'The model is cheaper and has a larger context window.' }];
const germanCard = JSON.stringify([{ id: 'a1', title: 'Ein neues Modell ist da', summary: 'Das Modell ist guenstiger und hat ein groesseres Kontextfenster fuer alle Nutzer.', why: 'Es macht Versuche billiger.', topics: ['llm', 'api'], substance: true }]);

let saved;

beforeEach(() => {
  saved = config.fresh;
  config.fresh = { ...saved, content: { language: 'German', languageCode: 'de', locale: 'de-DE' } };
  compat.setProviderConfig(null);
  compat.setTransport(null);
  rl.reset();
  store.kvSet('llm-usage', null);
});

afterEach(() => {
  config.fresh = saved;
  rl.reset();
  compat.setProviderConfig(null);
  compat.setTransport(null);
});

test('the writer prompt names the configured language and none of another one', async () => {
  const gw = await startGateway(compat);
  try {
    const seen = [];
    gw.handlers['POST /chat/completions'] = (req) => {
      seen.push(String(req.body.messages?.[0]?.content ?? ''));
      return { status: 200, body: { choices: [{ message: { content: germanCard } }] } };
    };
    gw.handlers['POST /classify'] = (req) => {
      const answers = {};
      for (const id of Object.keys(req.body.questions ?? {})) answers[id] = { type: 'bool', p: 0.9 };
      return { status: 200, body: { answers } };
    };
    const done = await llm.writeCards(agentOf(gw.url), batch(), { rules: new Map() });
    assert.equal(done.get('a1').path, 'free');
    assert.equal(seen.length, 1);
    const prompt = seen[0];
    assert.match(prompt, /German/, 'the writer is told which language to write in');
    assert.equal(done.get('a1').title_local, 'Ein neues Modell ist da', 'the card comes back as the provider wrote it');
    for (const marker of MARKERS) assert.equal(prompt.includes(marker), false, `the prompt must not contain "${marker}"`);
    assert.doesNotMatch(prompt, REPO_WORDS_RE, 'no filler words of another language');
  } finally {
    await gw.close();
  }
});

test('the classifier questions name the configured language too', async () => {
  const gw = await startGateway(compat);
  try {
    const questions = [];
    gw.handlers['POST /classify'] = (req) => {
      questions.push(JSON.stringify(req.body.questions));
      const answers = {};
      for (const [id, q] of Object.entries(req.body.questions ?? {})) {
        answers[id] = q.type === 'choice' ? { type: 'choice', choice: 'ai' } : q.type === 'score' ? { type: 'score', score: 3 } : { type: 'bool', p: 0.1 };
      }
      return { status: 200, body: { answers } };
    };
    const verdicts = await llm.triage(agentOf(gw.url), [{ id: 'a1', title: 'A new model', snippet: '', cat: 'ai' }]);
    assert.equal(verdicts.get('a1').by, 'model');
    assert.match(questions[0], /German/);
    for (const marker of MARKERS) assert.equal(questions[0].includes(marker), false, `no "${marker}" in the questions`);
  } finally {
    await gw.close();
  }
});
