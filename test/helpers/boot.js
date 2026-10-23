// Boots the web app against a fake Hermes agent, with everything in temp directories.
//
//   const app = await boot();                       // child process (default): the same entry point systemd uses
//   const app = await boot({ inProcess: true });    // imports server.js and calls start(); one app per test process
//   const app = await boot({ files: { 'providers.json': '{"providers":{},"capabilities":{}}' } });  // extra files in data/
//   const me = await app.login();                   // a signed-in client: me.get/post/put/patch/delete(path, body)
//   await app.stop();
//
// In-process mode sets the environment before server.js (and so src/config.js) is imported, which happens once per process.
import './fetch-guard.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeHermes, FAKE_KEY } from '../fake-hermes/server.js';
import { totp } from './totp.js';
import { seedFresh } from './seed-fresh.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const USERNAME = 'tester';
export const PASSWORD = 'correct horse battery staple';
export const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
export const RECOVERY_CODE = 'ABCDEF123456';
export const AGENT_NAME = 'test-agent';
export { totp, FAKE_KEY };

// A pre-computed login record for the credentials above (scrypt is slow; computing it for every test app would dominate the run).
// It holds only test credentials. test/unit/auth-lib.test.js checks that it still matches.
const authRecord = () => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'auth-record.json'), 'utf8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A client with a cookie jar that sends the CSRF token and a same-origin Origin header, like the browser does.
function makeClient(base) {
  const client = { cookie: '', csrf: '' };
  client.raw = (method, url, { json, body, headers = {}, origin = base, csrf = client.csrf, cookie = client.cookie } = {}) => fetch(base + url, {
    method, redirect: 'manual',
    headers: {
      Connection: 'close', // no idle sockets left in fetch's pool to hold the test process open
      ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  // -> { status, data, headers }; data is parsed JSON when the body is JSON, else the text.
  client.call = async (method, url, options) => {
    const response = await client.raw(method, url, options);
    const text = await response.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, data, headers: response.headers };
  };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    client[method] = (url, json, options = {}) => client.call(method.toUpperCase(), url, { json, ...options });
  }
  return client;
}

export async function boot(options = {}) {
  const { inProcess = false, seed = false, env = {}, fake: fakeOptions = {}, publicDir, files = {} } = options;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-web-test-'));
  const dataDir = path.join(dir, 'data');
  const hermesRoot = path.join(dir, 'hermes');
  const profileDir = path.join(hermesRoot, 'profiles', AGENT_NAME);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(profileDir, { recursive: true });

  const fake = await startFakeHermes(fakeOptions);
  fs.writeFileSync(path.join(profileDir, '.env'), `API_SERVER_ENABLED=true\nAPI_SERVER_PORT=${fake.port}\nAPI_SERVER_KEY=${FAKE_KEY}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(profileDir, 'config.yaml'), `model:\n  default: "fake-model"\n  provider: fake-provider\n  base_url: ${fake.url}/v1\n`);
  fs.writeFileSync(path.join(dataDir, 'auth-record.json'), authRecord(), { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'recovery-codes.json'), JSON.stringify({ used: [] }), { mode: 0o600 });
  // Cover pictures need an image model; the fake agent has none.
  fs.writeFileSync(path.join(dataDir, 'agent-settings.json'), JSON.stringify({ [AGENT_NAME]: { coversEnabled: false } }), { mode: 0o600 });
  // Extra files written into the data directory before the app starts (providers.json, fresh settings ...).
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dataDir, name), content, { mode: 0o600 });
  if (seed) seedFresh(dataDir, typeof seed === 'number' ? seed : 40);

  const appEnv = {
    HERMES_ROOT: hermesRoot, HERMES_WEB_DATA_DIR: dataDir, HERMES_WEB_AGENTS: AGENT_NAME, HERMES_WEB_PORT: '0', HERMES_WEB_HOSTS: '127.0.0.1',
    // An empty config file: the developer's own config.json in the repo root must not change what the tests see.
    HERMES_WEB_CONFIG: path.join(dir, 'config.json'),
    HERMES_WEB_FRESH_OFF: '1', HERMES_WEB_FRESH_OFFLINE: '1', ...(publicDir ? { HERMES_WEB_PUBLIC_DIR: publicDir } : {}), ...env,
  };
  fs.writeFileSync(appEnv.HERMES_WEB_CONFIG, '{}\n');

  let port, stopApp, logText = () => '', exited = () => false;
  if (inProcess) {
    Object.assign(process.env, appEnv);
    const { start } = await import('../../server.js');
    const running = await start({ port: 0, hosts: ['127.0.0.1'], fresh: false });
    port = running.port;
    stopApp = async () => {
      await running.close();
      // The app's own fetch() calls to the fake agent keep a pooled connection; drop it (in-process only: one app per process).
      await globalThis[Symbol.for('undici.globalDispatcher.1')]?.close?.().catch(() => {});
    };
  } else {
    const child = spawn(process.execPath, ['--import', path.join(ROOT, 'test', 'helpers', 'fetch-guard.js'), 'server.js'], {
      cwd: ROOT, env: { ...process.env, ...appEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (chunk) => { log += chunk; });
    child.stderr.on('data', (chunk) => { log += chunk; });
    logText = () => log;
    exited = () => child.exitCode !== null || child.signalCode !== null;
    const deadline = Date.now() + 20_000;
    while (!port && Date.now() < deadline) {
      port = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(log)?.[1]) || 0;
      if (child.exitCode !== null) throw new Error(`the app exited early (${child.exitCode}):\n${log}`);
      if (!port) await sleep(50);
    }
    if (!port) { child.kill(); throw new Error(`the app did not start:\n${log}`); }
    stopApp = async () => {
      if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); }, 3000).unref(); }); }
    };
  }

  const base = `http://127.0.0.1:${port}`;
  const app = {
    base, port, dir, exited: () => exited(), dataDir, hermesRoot, profileDir, fake, log: logText, client: () => makeClient(base),
    // Signs in (password + current authenticator code) and returns a client carrying the session cookie and CSRF token.
    async login() {
      const client = makeClient(base);
      const response = await client.raw('POST', '/api/login', { json: { username: USERNAME, password: PASSWORD, code: totp(TOTP_SECRET) } });
      if (response.status !== 200) throw new Error(`login failed: ${response.status} ${await response.text()}`);
      client.cookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
      client.csrf = (await client.get('/api/me')).data.csrf;
      return client;
    },
    async stop() {
      await stopApp();
      const violations = [...(globalThis.__networkViolations ?? [])];
      if (/NETWORK-GUARD/.test(logText())) violations.push(logText().split('\n').filter((line) => /NETWORK-GUARD/.test(line)).join('\n'));
      if (violations.length) { fs.rmSync(dir, { recursive: true, force: true }); await fake.close(); throw new Error(`the app tried to reach the network:\n${violations.join('\n')}`); }
      await fake.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return app;
}

// Waits until fn() returns something truthy (or throws after timeoutMs).
export async function waitFor(fn, { timeoutMs = 10_000, every = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}
