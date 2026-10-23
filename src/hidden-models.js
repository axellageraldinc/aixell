import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Which models the owner wants to see. The provider's API cannot tell (its console toggle is not exposed anywhere),
// so the list lives here, per provider, for every agent and device. Two shapes:
//   { allow: [ids] }  only these are shown (new models stay out of the way until switched on)
//   [ids]             older shape: these are hidden
const file = path.join(config.dataDir, 'hidden-models.json');
let store = {
  'opencode-go': { allow: ['claude-haiku-5-5', 'deepseek-v4.1-flash', 'gemini-3.5-flash-lite', 'glm-5.3-flash', 'gpt-6-luna', 'jev-1.13', 'mimo-v2.6-flash-free', 'minimax-m3', 'qwen3.6-plus', 'qwen3.8-flash'] },
};
try { store = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first run: the seed above */ }

function persist() {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// (modelId) => true when the model must not be listed by default.
export function hiddenCheck(provider) {
  const entry = store[provider];
  if (entry && !Array.isArray(entry) && Array.isArray(entry.allow)) {
    const allow = new Set(entry.allow);
    return (id) => !allow.has(id);
  }
  const hidden = new Set(Array.isArray(entry) ? entry : []);
  return (id) => hidden.has(id);
}

export function setModelHidden(provider, modelId, hidden) {
  const entry = store[provider];
  if (entry && !Array.isArray(entry) && Array.isArray(entry.allow)) {
    const allow = new Set(entry.allow);
    if (hidden) allow.delete(modelId);
    else allow.add(modelId);
    store[provider] = { allow: [...allow].sort() };
  } else {
    const list = new Set(Array.isArray(entry) ? entry : []);
    if (hidden) list.add(modelId);
    else list.delete(modelId);
    store[provider] = [...list].sort();
  }
  persist();
}
