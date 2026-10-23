// The connector registry: the built-in connector types plus drop-in files from a directory.
//
//   const registry = await createRegistry({ dir, builtins })
//   registry.types()            -> ["bluesky", "ghsa", "github-hype", "github-releases", "hn", "rss", "steam", "x-search", "youtube"]
//   registry.get("rss")         -> the Connector, or null
//   registry.instances(list)    -> [{ id, type, enabled, cat, limit, name, config, schedule, stack?, error? }]
//
// A drop-in is a `.js` file in `dir` whose default export is a Connector. A file that throws on
// import, fails validateConnector, or reuses a built-in type is skipped with a warning; start-up
// never fails because of one. `dir` defaults to `<dataDir>/connectors`; a missing directory is fine.
//
// Instances carry no credential data at all: the caller keeps the references and resolves them
// lazily through the connector context's `secret`.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { validateConnector } from './contract.js';
import rss from './rss.js';
import youtube from './youtube.js';
import githubReleases from './github-releases.js';
import ghsa from './ghsa.js';
import hn from './hn.js';
import bluesky from './bluesky.js';
import xSearch from './x-search.js';
import githubHype from './github-hype.js';
import steam from './steam.js';

export const BUILTINS = [rss, youtube, githubReleases, ghsa, hn, bluesky, xSearch, githubHype, steam];

const DEFAULT_LIMIT = 15;

function instanceOf(entry, connectors) {
  const type = String(entry?.type ?? '');
  const connector = connectors.get(type) ?? null;
  const cat = entry?.cat ?? 'ai';
  const limit = Number.isFinite(entry?.limit) ? entry.limit : DEFAULT_LIMIT;
  const name = entry?.name ?? connector?.title ?? type;
  const instance = {
    id: String(entry?.id ?? ''),
    type,
    enabled: entry?.enabled !== false,
    cat,
    limit,
    name,
    config: { ...(entry?.config ?? {}), id: String(entry?.id ?? ''), cat, limit, name },
    schedule: entry?.schedule ?? connector?.defaultSchedule ?? null,
  };
  if (entry?.stack) instance.stack = true;
  if (entry?.legacy) instance.legacy = String(entry.legacy);
  if (!connector) instance.error = 'unknown connector type';
  return instance;
}

export async function createRegistry({ dir, builtins = BUILTINS, log = console } = {}) {
  const warnings = [];
  const connectors = new Map();
  const warn = (message) => { warnings.push(message); log.warn(`[connectors] ${message}`); };

  for (const connector of builtins) {
    const errors = validateConnector(connector);
    if (errors.length) { warn(`built-in connector "${connector?.type ?? '?'}" skipped: ${errors.join('; ')}`); continue; }
    if (connectors.has(connector.type)) { warn(`built-in connector type "${connector.type}" is defined twice; the second one is ignored`); continue; }
    connectors.set(connector.type, connector);
  }

  const builtinTypes = new Set(connectors.keys());
  const dropInDir = dir ?? path.join(config.dataDir, 'connectors');

  let files = [];
  try {
    files = fs.readdirSync(dropInDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if (err?.code !== 'ENOENT') warn(`cannot read the connector directory: ${err.message}`);
  }

  for (const file of files) {
    const full = path.join(dropInDir, file);
    let mod;
    try {
      mod = await import(pathToFileURL(full).href);
    } catch (err) {
      warn(`connector "${file}" skipped: it could not be loaded (${err.message})`);
      continue;
    }
    const connector = mod?.default;
    const errors = validateConnector(connector);
    if (errors.length) { warn(`connector "${file}" skipped: ${errors.join('; ')}`); continue; }
    if (builtinTypes.has(connector.type)) { warn(`connector "${file}" rejected: type "${connector.type}" is built in`); continue; }
    if (connectors.has(connector.type)) { warn(`connector "${file}" rejected: type "${connector.type}" is already defined`); continue; }
    connectors.set(connector.type, connector);
  }

  return {
    warnings,
    types: () => [...connectors.keys()].sort(),
    get: (type) => connectors.get(type) ?? null,
    instances: (list) => (Array.isArray(list) ? list : []).map((entry) => instanceOf(entry, connectors)),
  };
}
