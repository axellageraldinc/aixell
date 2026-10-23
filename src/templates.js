import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError } from './http.js';

// Prompt templates for the composer's slash menu ("/summarise"), kept on the server so a phone and a desktop share them.
// One list per agent. A first run starts with a few useful ones.
const file = path.join(config.dataDir, 'templates.json');
const MAX_TEMPLATES = 40;
const MAX_TEXT = 4000;
const NAME = /^[\p{L}\p{N}_-]{1,24}$/u;

const DEFAULTS = [
  { name: 'summarise', text: 'Summarise this text in a few short bullet points:\n\n' },
  { name: 'translate', text: 'Translate this into natural English:\n\n' },
  { name: 'fix', text: 'Fix the grammar and spelling of this text without changing its meaning:\n\n' },
  { name: 'explain', text: 'Explain this in simple terms, with examples:\n\n' },
  { name: 'reply', text: 'Help me reply to this message politely but not stiffly:\n\n' },
];

let store = {};
try { store = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first run */ }

function persist() {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export const getTemplates = (agentName) => store[agentName] ?? DEFAULTS;

export function setTemplates(agentName, list) {
  if (!Array.isArray(list) || list.length > MAX_TEMPLATES) throw new HttpError(400, `At most ${MAX_TEMPLATES} templates.`, 'bad_templates');
  const seen = new Set();
  const clean = [];
  for (const item of list) {
    const name = String(item?.name ?? '').trim().replace(/^\//, '').toLowerCase();
    const text = typeof item?.text === 'string' ? item.text : '';
    if (!NAME.test(name)) throw new HttpError(400, 'Template name: 1–24 letters, digits, - or _.', 'bad_template_name');
    if (!text.trim() || text.length > MAX_TEXT) throw new HttpError(400, `Template text cannot be empty and is limited to ${MAX_TEXT} characters.`, 'bad_template_text');
    if (seen.has(name)) throw new HttpError(400, `The name "${name}" is used twice.`, 'dup_template');
    seen.add(name);
    clean.push({ name, text });
  }
  store[agentName] = clean;
  persist();
  return clean;
}
