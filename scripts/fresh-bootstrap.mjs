// One-off full first fill of the Fresh feed, run inside the live server (see src/fresh/bootstrap.js).
//   node scripts/fresh-bootstrap.mjs [--force] [--url http://127.0.0.1:8300]
// Reads the ingest token from data/fresh/ingest-token (never printed), starts the job, then prints progress lines until it ends.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const force = args.includes('--force');
const base = (args.includes('--url') ? args[args.indexOf('--url') + 1] : process.env.HERMES_WEB_URL) ?? 'http://127.0.0.1:8300';
const dataDir = process.env.HERMES_WEB_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
let token = '';
try { token = fs.readFileSync(path.join(dataDir, 'fresh', 'ingest-token'), 'utf8').trim(); } catch { /* reported below */ }
if (!token) { console.error('No ingest token (data/fresh/ingest-token).'); process.exit(2); }

const call = async (method, query = '') => {
  const res = await fetch(`${base}/api/fresh/bootstrap${query}`, { method, headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const line = (job) => {
  const s = job.steps;
  const part = (k) => {
    const x = s[k];
    if (!x) return '';
    if (k === 'drain') return `drain=${x.status}${x.rounds !== undefined ? `(rounds ${x.rounds}, ready +${x.ready}, left ${x.queueLeft}${x.stopped ? `, ${x.stopped}` : ''})` : ''}`;
    if (k === 'x') return `x=${x.status}${x.calls !== undefined ? `(calls ${x.calls}/${job.x.budget}, cost ${Math.round(job.x.cost)}, +${x.added})` : ''}`;
    return `${k}=${x.status}${x.status === 'done' ? `(+${x.added}, dup ${x.dup}, skip ${x.skipped})` : x.reason ? `(${x.reason})` : ''}`;
  };
  return `[${job.state}] ${['feeds', 'bluesky', 'github', 'steam', 'x', 'drain'].map(part).join(' ')}`;
};

const start = await call('POST', force ? '?force=1' : '');
if (start.status === 429) { console.error(`${start.body.error?.message} Next possible: ${new Date(start.body.nextAt).toISOString()}`); process.exit(3); }
if (![202, 409].includes(start.status)) { console.error(`Could not start (HTTP ${start.status}): ${start.body.error?.message ?? ''}`); process.exit(1); }
console.log(start.status === 409 ? 'A bootstrap is already running; following it.' : `Started job ${start.body.job.id}.`);

let last = '';
for (;;) {
  const { status, body } = await call('GET');
  if (status !== 200) { console.error(`Progress failed (HTTP ${status}).`); process.exit(1); }
  const text = line(body.job);
  if (text !== last) { console.log(text); last = text; }
  if (body.job.state !== 'running') {
    console.log('Summary:', JSON.stringify(body.job.summary));
    for (const e of body.job.errors) console.log('  error:', e);
    process.exit(body.job.state === 'error' ? 1 : 0);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
