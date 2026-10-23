// Resolves the secret references used in config.json and provider configs.
//
//   env:NAME                 environment variable NAME
//   agentEnv:NAME            variable NAME from the Hermes profile's .env (via the agentEnv callback)
//   file:relative/path       a file inside the data directory, read as text
//   file:relative/path#field a JSON file inside the data directory; the value of `field`
//
// A plain literal is refused unless `allowInline` is true. A missing source resolves to
// null (the caller decides whether that is fatal); a malformed reference or a path that
// escapes the data directory throws. Error messages never contain a secret value.

import fs from 'node:fs';
import path from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const inside = (base, target) => {
  const root = path.resolve(base);
  const resolved = path.resolve(root, target);
  return resolved === root || resolved.startsWith(root + path.sep);
};

const readJsonFile = (file, field) => {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never repeat the parser message: Node includes a snippet of the file in it, and
    // the file may hold a credential.
    throw new ConfigError(`secret file for "${field}" is not valid JSON`);
  }
  const value = parsed?.[field];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

export function resolveSecret(ref, { dataDir, allowInline = false, env = process.env, agentEnv } = {}) {
  if (typeof ref !== 'string' || !ref.trim()) throw new ConfigError('a secret reference must be a non-empty string');

  const match = /^(env|agentEnv|file):(.+)$/.exec(ref);
  if (!match) {
    if (allowInline) return ref;
    throw new ConfigError('a literal secret is not allowed here; use env:NAME, agentEnv:NAME or file:path (set allowInlineSecrets to allow literals)');
  }

  const [, kind, rest] = match;

  if (kind === 'env') return env[rest] || null;

  if (kind === 'agentEnv') {
    if (typeof agentEnv !== 'function') return null;
    return agentEnv(rest) ?? null;
  }

  // file:
  const hash = rest.lastIndexOf('#');
  const rel = hash === -1 ? rest : rest.slice(0, hash);
  const field = hash === -1 ? null : rest.slice(hash + 1);
  if (!rel || (field !== null && !field)) throw new ConfigError('a file secret reference needs a path, and a field name after "#" when one is given');
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || rel.includes('\0')) {
    throw new ConfigError('secret file path is not allowed: it must be a relative path inside the data directory');
  }
  if (!dataDir) throw new ConfigError('cannot resolve a file secret without a data directory');
  if (!inside(dataDir, rel)) throw new ConfigError('secret file path is not allowed: it must be a relative path inside the data directory');
  const file = path.resolve(dataDir, rel);
  // A symlink inside the data directory must not point outside it either.
  try {
    if (!inside(dataDir, path.relative(path.resolve(dataDir), fs.realpathSync(file)))) {
      throw new ConfigError('secret file path is not allowed: it resolves outside the data directory');
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    // Missing file: fall through; the read below answers "not configured".
  }

  if (field !== null) return readJsonFile(file, field);

  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// Resolves a text reference with the same path rules as a file secret, but returns the text
// as it is (a taste profile, a prompt note). A plain string is the text itself; only `file:`
// references touch the disk. A missing file answers null.
export function readTextRef(ref, { dataDir } = {}) {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  if (!ref.startsWith('file:')) return ref;
  const rel = ref.slice(5);
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || rel.includes('\0')) {
    throw new ConfigError('text file path is not allowed: it must be a relative path inside the data directory');
  }
  if (!dataDir) throw new ConfigError('cannot resolve a text file reference without a data directory');
  if (!inside(dataDir, rel)) throw new ConfigError('text file path is not allowed: it must be a relative path inside the data directory');
  const file = path.resolve(dataDir, rel);
  try {
    if (!inside(dataDir, path.relative(path.resolve(dataDir), fs.realpathSync(file)))) {
      throw new ConfigError('text file path is not allowed: it resolves outside the data directory');
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
  }
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}
