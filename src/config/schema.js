import { validateSpec } from '../scheduler/schedule-spec.js';
// Hand-written schema for config.json. No dependencies.
//
//   const { value, errors, warnings } = validate(raw)
//
// `value` contains only known keys, in a stable order. Unknown keys are dropped and
// reported as warnings; wrong types are errors with a path-qualified message
// ("server.port: must be ..."). Keys that later phases fill in are accepted as opaque
// objects and are not inspected yet.

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Accepted without inner validation until the phase that owns them lands.
export const OPAQUE_KEYS = [
  'providers',
  'notifications',
  'budgets',
  'capabilities',
  'chat',
  'covers',
  'locale',
  'telegramImport',
];

const KNOWN_KEYS = ['appName', 'server', 'agents', 'hermesRoot', 'timezone', 'push', 'allowInlineSecrets', 'connectors', 'connectorsDir', 'fresh'];
const SERVER_KEYS = ['port', 'hosts', 'allowedHosts', 'trustCloudflare', 'cookieSecure', 'sessionDays', 'orphanStopMinutes'];
const PUSH_KEYS = ['subject'];
const CONNECTOR_KEYS = ['id', 'type', 'enabled', 'cat', 'limit', 'config', 'credentials', 'schedule', 'name', 'stack'];
const FRESH_KEYS = ['content', 'categories', 'taste', 'filters', 'writer'];
const CONTENT_KEYS = ['language', 'languageCode', 'locale'];
const CATEGORY_KEYS = ['id', 'label', 'halfLifeHours', 'keywords'];
const KEYWORD_KEYS = ['pos', 'neg'];
const TASTE_KEYS = ['profile'];
const FILTERS_KEYS = ['packs'];
const WRITER_KEYS = ['titleMax', 'summaryMaxWords', 'whyMaxWords'];

const isString = (value) => typeof value === 'string' && value.length > 0;
const isStringArray = (value) => Array.isArray(value) && value.every(isString);
const isInteger = (value) => Number.isInteger(value);
const isPositiveNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isPositiveInteger = (value) => isInteger(value) && value > 0;

// A time zone name Node can format with; anything else would only fail much later, at the first date.
export const isTimeZone = (value) => {
  if (typeof value !== 'string' || !value) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const isRegex = (value) => {
  if (typeof value !== 'string' || !value) return false;
  try {
    new RegExp(value, 'i');
    return true;
  } catch {
    return false;
  }
};

// fresh: content language, categories, taste profile, filter packs and writer limits. Only the
// keys that are given are copied; the loaders in src/fresh/ fill in the neutral defaults.
function validateFresh(input, errors, warnings) {
  if (!isPlainObject(input)) {
    errors.push('fresh: must be an object');
    return undefined;
  }
  const out = {};
  for (const key of Object.keys(input)) {
    if (!FRESH_KEYS.includes(key)) warnings.push(`fresh.${key}: unknown key (ignored)`);
  }

  if (input.content !== undefined) {
    if (!isPlainObject(input.content)) errors.push('fresh.content: must be an object');
    else {
      const content = {};
      for (const key of Object.keys(input.content)) {
        if (!CONTENT_KEYS.includes(key)) warnings.push(`fresh.content.${key}: unknown key (ignored)`);
      }
      for (const key of CONTENT_KEYS) {
        if (input.content[key] === undefined) continue;
        if (isString(input.content[key])) content[key] = input.content[key];
        else errors.push(`fresh.content.${key}: must be a non-empty string`);
      }
      out.content = content;
    }
  }

  if (input.categories !== undefined) {
    if (!Array.isArray(input.categories)) errors.push('fresh.categories: must be an array');
    else {
      const ids = new Set();
      const list = [];
      input.categories.forEach((entry, index) => {
        const at = `fresh.categories[${index}]`;
        if (!isPlainObject(entry)) { errors.push(`${at}: must be an object`); return; }
        for (const key of Object.keys(entry)) {
          if (!CATEGORY_KEYS.includes(key)) warnings.push(`${at}.${key}: unknown key (ignored)`);
        }
        const category = {};
        if (!isString(entry.id)) errors.push(`${at}.id: must be a non-empty string`);
        else if (ids.has(entry.id)) errors.push(`${at}.id: duplicate category id "${entry.id}"`);
        else { ids.add(entry.id); category.id = entry.id; }
        if (!isString(entry.label)) errors.push(`${at}.label: must be a non-empty string`);
        else category.label = entry.label;
        if (!isPositiveNumber(entry.halfLifeHours)) errors.push(`${at}.halfLifeHours: must be a number > 0`);
        else category.halfLifeHours = entry.halfLifeHours;
        if (entry.keywords !== undefined) {
          if (!isPlainObject(entry.keywords)) errors.push(`${at}.keywords: must be an object`);
          else {
            const keywords = {};
            for (const key of Object.keys(entry.keywords)) {
              if (!KEYWORD_KEYS.includes(key)) warnings.push(`${at}.keywords.${key}: unknown key (ignored)`);
            }
            for (const key of KEYWORD_KEYS) {
              if (entry.keywords[key] === undefined) continue;
              if (!isRegex(entry.keywords[key])) errors.push(`${at}.keywords.${key}: must be a valid regular expression`);
              else keywords[key] = entry.keywords[key];
            }
            category.keywords = keywords;
          }
        }
        list.push(category);
      });
      out.categories = list;
    }
  }

  if (input.taste !== undefined) {
    if (!isPlainObject(input.taste)) errors.push('fresh.taste: must be an object');
    else {
      const taste = {};
      for (const key of Object.keys(input.taste)) {
        if (!TASTE_KEYS.includes(key)) warnings.push(`fresh.taste.${key}: unknown key (ignored)`);
      }
      if (input.taste.profile !== undefined) {
        if (isString(input.taste.profile)) taste.profile = input.taste.profile;
        else errors.push('fresh.taste.profile: must be a non-empty string (the text, or a file: reference)');
      }
      out.taste = taste;
    }
  }

  if (input.filters !== undefined) {
    if (!isPlainObject(input.filters)) errors.push('fresh.filters: must be an object');
    else {
      const filters = {};
      for (const key of Object.keys(input.filters)) {
        if (!FILTERS_KEYS.includes(key)) warnings.push(`fresh.filters.${key}: unknown key (ignored)`);
      }
      if (input.filters.packs !== undefined) {
        if (isStringArray(input.filters.packs)) filters.packs = [...input.filters.packs];
        else errors.push('fresh.filters.packs: must be an array of non-empty strings');
      }
      out.filters = filters;
    }
  }

  if (input.writer !== undefined) {
    if (!isPlainObject(input.writer)) errors.push('fresh.writer: must be an object');
    else {
      const writer = {};
      for (const key of Object.keys(input.writer)) {
        if (!WRITER_KEYS.includes(key)) warnings.push(`fresh.writer.${key}: unknown key (ignored)`);
      }
      for (const key of WRITER_KEYS) {
        if (input.writer[key] === undefined) continue;
        if (isPositiveInteger(input.writer[key])) writer[key] = input.writer[key];
        else errors.push(`fresh.writer.${key}: must be a positive integer`);
      }
      out.writer = writer;
    }
  }

  return out;
}


export function validate(input) {
  const errors = [];
  const warnings = [];
  const value = {};

  if (!isPlainObject(input)) {
    return { value, errors: ['config: must be an object'], warnings };
  }

  for (const key of Object.keys(input)) {
    if (KNOWN_KEYS.includes(key) || OPAQUE_KEYS.includes(key)) continue;
    warnings.push(`${key}: unknown key (ignored)`);
  }

  if (input.appName !== undefined) {
    if (isString(input.appName)) value.appName = input.appName;
    else errors.push('appName: must be a non-empty string');
  }

  if (input.server !== undefined) {
    if (!isPlainObject(input.server)) {
      errors.push('server: must be an object');
    } else {
      const server = input.server;
      const out = {};
      for (const key of Object.keys(server)) {
        if (!SERVER_KEYS.includes(key)) warnings.push(`server.${key}: unknown key (ignored)`);
      }
      if (server.port !== undefined) {
        if (isInteger(server.port) && server.port >= 0 && server.port <= 65535) out.port = server.port;
        else errors.push('server.port: must be an integer between 0 and 65535');
      }
      if (server.hosts !== undefined) {
        if (isStringArray(server.hosts)) out.hosts = [...server.hosts];
        else errors.push('server.hosts: must be an array of non-empty strings');
      }
      if (server.allowedHosts !== undefined) {
        if (isStringArray(server.allowedHosts)) out.allowedHosts = [...server.allowedHosts];
        else errors.push('server.allowedHosts: must be an array of non-empty strings');
      }
      if (server.trustCloudflare !== undefined) {
        if (typeof server.trustCloudflare === 'boolean') out.trustCloudflare = server.trustCloudflare;
        else errors.push('server.trustCloudflare: must be a boolean');
      }
      if (server.cookieSecure !== undefined) {
        if (typeof server.cookieSecure === 'boolean') out.cookieSecure = server.cookieSecure;
        else errors.push('server.cookieSecure: must be a boolean');
      }
      if (server.sessionDays !== undefined) {
        if (isInteger(server.sessionDays) && server.sessionDays > 0) out.sessionDays = server.sessionDays;
        else errors.push('server.sessionDays: must be a positive integer');
      }
      if (server.orphanStopMinutes !== undefined) {
        if (typeof server.orphanStopMinutes === 'number' && Number.isFinite(server.orphanStopMinutes) && server.orphanStopMinutes >= 0) {
          out.orphanStopMinutes = server.orphanStopMinutes;
        } else {
          errors.push('server.orphanStopMinutes: must be a number >= 0');
        }
      }
      value.server = out;
    }
  }

  if (input.agents !== undefined) {
    if (isStringArray(input.agents)) value.agents = [...input.agents];
    else errors.push('agents: must be an array of non-empty strings');
  }

  if (input.hermesRoot !== undefined) {
    if (isString(input.hermesRoot)) value.hermesRoot = input.hermesRoot;
    else errors.push('hermesRoot: must be a non-empty string');
  }

  if (input.timezone !== undefined) {
    if (!isString(input.timezone)) errors.push('timezone: must be a non-empty string');
    else if (!isTimeZone(input.timezone)) errors.push(`timezone: must be a valid IANA time zone name (got "${input.timezone}")`);
    else value.timezone = input.timezone;
  }

  if (input.push !== undefined) {
    if (!isPlainObject(input.push)) {
      errors.push('push: must be an object');
    } else {
      const out = {};
      for (const key of Object.keys(input.push)) {
        if (!PUSH_KEYS.includes(key)) warnings.push(`push.${key}: unknown key (ignored)`);
      }
      if (input.push.subject !== undefined) {
        if (isString(input.push.subject)) out.subject = input.push.subject;
        else errors.push('push.subject: must be a non-empty string');
      }
      value.push = out;
    }
  }

  if (input.allowInlineSecrets !== undefined) {
    if (typeof input.allowInlineSecrets === 'boolean') value.allowInlineSecrets = input.allowInlineSecrets;
    else errors.push('allowInlineSecrets: must be a boolean');
  }

  if (input.fresh !== undefined) {
    const fresh = validateFresh(input.fresh, errors, warnings);
    if (fresh !== undefined) value.fresh = fresh;
  }

  for (const key of OPAQUE_KEYS) {
    if (input[key] === undefined) continue;
    if (isPlainObject(input[key])) value[key] = input[key];
    else errors.push(`${key}: must be an object`);
  }

  if (input.connectors !== undefined) {
    if (!Array.isArray(input.connectors)) {
      errors.push('connectors: must be an array of connector instances');
    } else {
      const seen = new Set();
      value.connectors = input.connectors.map((entry, index) => {
        const at = `connectors[${index}]`;
        if (!isPlainObject(entry)) { errors.push(`${at}: must be an object`); return null; }
        const out = {};
        for (const key of Object.keys(entry)) {
          if (!CONNECTOR_KEYS.includes(key)) warnings.push(`${at}.${key}: unknown key (ignored)`);
        }
        if (isString(entry.id)) {
          if (seen.has(entry.id)) errors.push(`${at}.id: duplicate id "${entry.id}"`);
          seen.add(entry.id);
          out.id = entry.id;
        } else errors.push(`${at}.id: must be a non-empty string`);
        if (isString(entry.type)) out.type = entry.type;
        else errors.push(`${at}.type: must be a non-empty string`);
        if (entry.enabled !== undefined) {
          if (typeof entry.enabled === 'boolean') out.enabled = entry.enabled;
          else errors.push(`${at}.enabled: must be a boolean`);
        }
        if (isString(entry.cat)) out.cat = entry.cat;
        else errors.push(`${at}.cat: must be a non-empty string`);
        if (typeof entry.limit === 'number' && Number.isFinite(entry.limit) && entry.limit >= 0) out.limit = entry.limit;
        else errors.push(`${at}.limit: must be a number >= 0`);
        if (isPlainObject(entry.config)) out.config = { ...entry.config };
        else errors.push(`${at}.config: must be an object`);
        if (entry.credentials !== undefined) {
          if (!isPlainObject(entry.credentials)) {
            errors.push(`${at}.credentials: must be an object of secret references`);
          } else {
            const creds = {};
            for (const [key, ref] of Object.entries(entry.credentials)) {
              if (isString(ref)) creds[key] = ref;
              else errors.push(`${at}.credentials.${key}: must be a secret reference string`);
            }
            out.credentials = creds;
          }
        }
        if (entry.schedule !== undefined) {
          if (!isPlainObject(entry.schedule)) errors.push(`${at}.schedule: must be an object`);
          else {
            const problem = validateSpec(entry.schedule);
            if (problem) errors.push(`${at}.${problem}`);
            else out.schedule = { ...entry.schedule };
          }
        }
        if (entry.name !== undefined) {
          if (isString(entry.name)) out.name = entry.name;
          else errors.push(`${at}.name: must be a non-empty string`);
        }
        if (entry.stack !== undefined) {
          if (typeof entry.stack === 'boolean') out.stack = entry.stack;
          else errors.push(`${at}.stack: must be a boolean`);
        }
        return out;
      }).filter(Boolean);
    }
  }

  if (input.connectorsDir !== undefined) {
    if (isString(input.connectorsDir)) value.connectorsDir = input.connectorsDir;
    else errors.push('connectorsDir: must be a non-empty string');
  }

  return { value, errors, warnings };
}
