// Finds, reads, validates and merges config.json (or config.jsonc) with the environment.
//
//   const { settings, config, file, warnings } = loadConfig()
//
// Precedence: built-in defaults < file < environment. The environment keys are the ones
// the app has always read, so an existing deployment keeps working without a file.
// A missing file is not an error: the defaults apply.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './schema.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const list = (value, fallback) => (value ?? fallback).split(',').map((item) => item.trim()).filter(Boolean);

export const defaults = () => ({
  server: {
    port: 8300,
    hosts: ['127.0.0.1'],
    allowedHosts: [],
    trustCloudflare: false,
    cookieSecure: false,
    sessionDays: 30,
    orphanStopMinutes: 20,
  },
  agents: ['default'],
  hermesRoot: path.join(os.homedir(), '.hermes'),
  timezone: 'UTC',
  fresh: {},
  push: { subject: 'mailto:admin@example.invalid' },
  allowInlineSecrets: false,
});

// Removes // and /* */ comments without touching their markers inside strings.
export function stripComments(text) {
  let out = '';
  let quote = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < text.length) { out += text[i + 1]; i += 2; continue; }
      } else if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// The path the app reads, or null when no file exists. HERMES_WEB_CONFIG is authoritative:
// when it is set and missing, that is a mistake worth reporting rather than silently ignoring.
// A relative path there is resolved against the working directory, like any CLI path.
export function findConfigFile({ root = ROOT, env = process.env } = {}) {
  const explicit = env.HERMES_WEB_CONFIG;
  if (explicit) {
    const file = path.resolve(explicit);
    if (!fs.existsSync(file)) throw new Error(`config: HERMES_WEB_CONFIG points at a file that does not exist: ${file}`);
    return file;
  }
  for (const name of ['config.json', 'config.jsonc']) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export function readConfigFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`config: cannot read ${file}: ${error.code ?? 'read failed'}`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const body = stripComments(text);
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`config: ${file} is not valid JSON: ${error.message}`);
  }
}

// defaults < file: a shallow merge per section, with server and push merged key by key.
export function mergeConfig(base, file) {
  const merged = { ...base, ...file };
  merged.server = { ...base.server, ...(file.server ?? {}) };
  merged.push = { ...base.push, ...(file.push ?? {}) };
  return merged;
}

const envValue = (env, name) => {
  const value = env[name];
  return value === undefined || value === '' ? null : value;
};

// Environment overrides, applied last. Each one reproduces exactly what src/config.js read
// before, including the difference between an unset variable (use the file/default) and an
// empty one (the old code produced an empty list).
export function applyEnv(merged, env = process.env) {
  const out = { ...merged, server: { ...merged.server }, push: { ...merged.push } };
  if (envValue(env, 'HERMES_WEB_PORT') !== null) out.server.port = Number(env.HERMES_WEB_PORT);
  if (env.HERMES_WEB_HOSTS !== undefined) out.server.hosts = list(env.HERMES_WEB_HOSTS, '');
  if (env.HERMES_WEB_ALLOWED_HOSTS !== undefined) out.server.allowedHosts = list(env.HERMES_WEB_ALLOWED_HOSTS, '');
  if (env.HERMES_WEB_AGENTS !== undefined) out.agents = list(env.HERMES_WEB_AGENTS, '');
  if (envValue(env, 'HERMES_WEB_SESSION_DAYS') !== null) out.server.sessionDays = Number(env.HERMES_WEB_SESSION_DAYS);
  if (env.HERMES_WEB_COOKIE_SECURE !== undefined) out.server.cookieSecure = env.HERMES_WEB_COOKIE_SECURE === '1';
  if (env.HERMES_WEB_TRUST_CLOUDFLARE !== undefined) out.server.trustCloudflare = env.HERMES_WEB_TRUST_CLOUDFLARE === '1';
  if (envValue(env, 'HERMES_WEB_ORPHAN_STOP_MIN') !== null) out.server.orphanStopMinutes = Number(env.HERMES_WEB_ORPHAN_STOP_MIN);
  if (envValue(env, 'HERMES_WEB_PUSH_SUBJECT') !== null) out.push.subject = env.HERMES_WEB_PUSH_SUBJECT;
  if (envValue(env, 'HERMES_ROOT') !== null) out.hermesRoot = env.HERMES_ROOT;
  return out;
}

// Validates what came out of the file (before env, which is trusted as it always was) and
// returns the settings the rest of the app builds `config` from.
export function loadConfig({ root = ROOT, env = process.env } = {}) {
  const file = findConfigFile({ root, env });
  const base = defaults();
  const fileConfig = file ? readConfigFile(file) : {};
  const checked = validate(fileConfig);
  if (checked.errors.length) {
    throw new Error(`config: invalid configuration${file ? ` in ${file}` : ''}:\n${checked.errors.map((message) => `  - ${message}`).join('\n')}`);
  }
  const merged = applyEnv(mergeConfig(base, checked.value), env);
  return {
    file,
    warnings: checked.warnings,
    settings: merged,
    config: toRuntimeConfig(merged, { root, env }),
  };
}

// The exact shape src/config.js exported before P5a (plus `appName`, only when set).
export function toRuntimeConfig(settings, { root = ROOT, env = process.env } = {}) {
  const hosts = settings.server.hosts;
  const config = {
    root,
    dataDir: envValue(env, 'HERMES_WEB_DATA_DIR') || path.join(root, 'data'),
    publicDir: envValue(env, 'HERMES_WEB_PUBLIC_DIR') || path.join(root, 'public'),
    port: settings.server.port,
    hosts,
    allowedHostnames: new Set(['localhost', ...hosts, ...settings.server.allowedHosts]),
    hermesRoot: settings.hermesRoot,
    agentNames: settings.agents,
    sessionDays: settings.server.sessionDays,
    sessionMaxAgeDays: 90,
    cookieSecure: settings.server.cookieSecure,
    trustCloudflare: settings.server.trustCloudflare,
    orphanStopMinutes: settings.server.orphanStopMinutes,
    timezone: settings.timezone,
    fresh: settings.fresh ?? {},
    uploadMaxBytes: 25 * 1024 * 1024,
    textInlineMaxBytes: 100 * 1024,
    jsonBodyMaxBytes: 2 * 1024 * 1024,
  };
  if (settings.appName) config.appName = settings.appName;
  return config;
}
