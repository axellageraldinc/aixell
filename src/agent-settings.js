import fs from 'node:fs';
import path from 'node:path';
import { config, EFFORT_LEVELS } from './config.js';
import { HttpError } from './http.js';

// Settings that belong to the web agent only. The shared parts (SOUL.md, memories, the holographic memory store,
// skills) are linked to the default profile on disk, so editing them there shows up here at once; what is stored
// here is added on top of that on every chat request (as the session's system message).
const file = path.join(config.dataDir, 'agent-settings.json');
const PERSONALITY_MAX = 4000;
let store = {};
try { store = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first run */ }

function persist() {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// 'auto' lets the speech model detect the language; the others steer it with a hint. The names come from the platform's
// language data, so only the ISO codes are listed here.
const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
export const STT_LANGUAGE_NAMES = Object.fromEntries(['en', 'id', 'es', 'fr', 'de', 'pt', 'ja', 'zh'].map((code) => [code, languageNames.of(code)]));
export const STT_LANGUAGES = ['auto', ...Object.keys(STT_LANGUAGE_NAMES)];
export const getSttLanguage = (agentName) => store[agentName]?.sttLanguage ?? 'auto';

export function setSttLanguage(agentName, value) {
  if (!STT_LANGUAGES.includes(value)) throw new HttpError(400, 'Unknown voice language.', 'bad_stt_language');
  store[agentName] = { ...store[agentName], sttLanguage: value };
  persist();
}

// Default model and effort of the web chat: what the model picker shows (and sends) until a chat picks something else.
// Empty = follow the agent's own config.yaml. Kept here, not in Hermes' config, so it applies at once with no restart.
const MODEL_ID = /^[\w.:/@-]{1,120}$/;
export const getDefaultModel = (agentName) => ({ model: store[agentName]?.defaultModel ?? '', provider: store[agentName]?.defaultProvider ?? '', effort: store[agentName]?.defaultEffort ?? '' });

export function setDefaultModel(agentName, { model = '', provider = '', effort = '' } = {}) {
  if (typeof model !== 'string' || (model && !MODEL_ID.test(model))) throw new HttpError(400, 'Unknown model.', 'bad_default_model');
  if (typeof provider !== 'string' || (provider && !MODEL_ID.test(provider))) throw new HttpError(400, 'Unknown provider.', 'bad_default_provider');
  if (effort !== '' && !EFFORT_LEVELS.includes(effort)) throw new HttpError(400, 'Unknown effort level.', 'bad_default_effort');
  store[agentName] = { ...store[agentName], defaultModel: model, defaultProvider: model ? provider : '', defaultEffort: effort };
  persist();
}

// The model list the picker gets, with the web default laid over the agent's own: `current` is what a chat starts on,
// `agentDefault` what Hermes itself would use. A saved model that is no longer offered is ignored.
export function applyDefaultModel(agentName, data) {
  const d = getDefaultModel(agentName);
  const out = { ...data, agentDefault: data.current };
  const known = d.model ? data.models?.find((m) => m.id === d.model) : null;
  if (known) out.current = { provider: d.provider || known.provider || data.current?.provider, model: known.id };
  if (d.effort) out.defaultEffort = d.effort;
  return out;
}

// Cover pictures in the Feed home (drawn from each chat's first message). On unless switched off.
export const getCoversEnabled = (agentName) => store[agentName]?.coversEnabled !== false;
export function setCoversEnabled(agentName, value) {
  if (typeof value !== 'boolean') throw new HttpError(400, 'coversEnabled must be true or false.', 'bad_covers');
  store[agentName] = { ...store[agentName], coversEnabled: value };
  persist();
}

export const getPersonality = (agentName) => store[agentName]?.personality ?? '';

export function setPersonality(agentName, value) {
  if (typeof value !== 'string') throw new HttpError(400, 'personality must be text.', 'bad_personality');
  const text = value.trim();
  if (text.length > PERSONALITY_MAX) throw new HttpError(400, `Personality is limited to ${PERSONALITY_MAX} characters.`, 'personality_too_long');
  store[agentName] = { ...store[agentName], personality: text };
  persist();
}

// What this agent shares with the default profile, checked on disk so the settings page never lies.
export function sharedWithDefault(agent) {
  const root = config.hermesRoot;
  const same = (relative) => {
    try { return fs.realpathSync(path.join(agent.home, relative)) === fs.realpathSync(path.join(root, relative)); } catch { return false; }
  };
  let soul = '';
  try { soul = fs.readFileSync(path.join(root, 'SOUL.md'), 'utf8'); } catch { /* none */ }
  let memoryDb = false;
  try { memoryDb = /db_path:\s*\S*memory_store\.db/.test(fs.readFileSync(path.join(agent.home, 'config.yaml'), 'utf8')); } catch { /* none */ }
  return {
    items: [
      { key: 'soul', label: 'Base personality (SOUL.md)', shared: same('SOUL.md') },
      { key: 'memories', label: 'Notes & user profile (MEMORY.md, USER.md)', shared: same('memories') },
      { key: 'memory_store', label: 'Long-term memory (holographic facts)', shared: memoryDb },
      { key: 'skills', label: 'Skills', shared: /external_dirs:\s*\n\s*-\s*\S*\/\.hermes\/skills/.test(readConfig(agent)) },
    ],
    soul: soul.slice(0, 6000),
  };
}

function readConfig(agent) {
  try { return fs.readFileSync(path.join(agent.home, 'config.yaml'), 'utf8'); } catch { return ''; }
}
