import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError } from './http.js';
import { runHermesScript } from './hermes-python.js';

// What the agent has learned: long-term facts (the holographic memory plugin), the two note files (MEMORY.md,
// USER.md) and the skills folder. Memory and skills are shared with the default profile on disk, so editing here edits both.
const SEP = '\n§\n';
const readConfig = (agent) => { try { return fs.readFileSync(path.join(agent.home, 'config.yaml'), 'utf8'); } catch { return ''; } };

function dbPath(agent) {
  const found = readConfig(agent).match(/db_path:\s*(\S+memory_store\.db)/)?.[1];
  return found ?? path.join(config.hermesRoot, 'memory_store.db');
}

// ---------- facts ----------
export async function listFacts(agent) {
  const { facts } = await runHermesScript('memory.py', [agent.home, dbPath(agent)], { action: 'list' });
  return facts ?? [];
}

export async function updateFact(agent, id, content) {
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text || text.length > 2000) throw new HttpError(400, 'A fact needs 1 to 2000 characters.', 'bad_fact');
  const result = await runHermesScript('memory.py', [agent.home, dbPath(agent)], { action: 'update', id, content: text });
  if (result.error === 'duplicate') throw new HttpError(409, 'Another fact already says exactly this.', 'duplicate_fact');
  if (result.error) throw new HttpError(400, result.detail || 'The fact was not accepted.', 'bad_fact');
  if (!result.ok) throw new HttpError(404, 'That fact no longer exists.', 'no_fact');
}

export async function removeFact(agent, id) {
  const result = await runHermesScript('memory.py', [agent.home, dbPath(agent)], { action: 'remove', id });
  if (!result.ok) throw new HttpError(404, 'That fact no longer exists.', 'no_fact');
}

// ---------- notes ----------
const NOTES = { memory: { file: 'MEMORY.md', key: 'memory_char_limit', fallback: 2200 }, user: { file: 'USER.md', key: 'user_char_limit', fallback: 1375 } };

function noteInfo(agent, which) {
  const note = NOTES[which];
  if (!note) throw new HttpError(404, 'Unknown note file.', 'bad_note');
  const limit = Number(readConfig(agent).match(new RegExp(`${note.key}:\\s*(\\d+)`))?.[1]) || note.fallback;
  return { file: path.join(agent.home, 'memories', note.file), limit };
}

export function readNotes(agent) {
  const out = {};
  for (const which of Object.keys(NOTES)) {
    const { file, limit } = noteInfo(agent, which);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
    out[which] = { entries: text.split(SEP).map((e) => e.trim()).filter(Boolean), limit };
  }
  return out;
}

export function writeNotes(agent, which, entries) {
  const { file, limit } = noteInfo(agent, which);
  if (!Array.isArray(entries) || entries.some((e) => typeof e !== 'string')) throw new HttpError(400, 'entries must be a list of text.', 'bad_entries');
  const clean = entries.map((e) => e.trim()).filter(Boolean);
  const text = clean.join(SEP);
  if (text.length > limit) throw new HttpError(400, `Too long: ${text.length} of ${limit} characters. The agent cannot load more than that, so shorten or delete something.`, 'notes_too_long');
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return { entries: clean, limit };
}

// ---------- skills ----------
const skillsRoot = (agent) => { try { return fs.realpathSync(path.join(agent.home, 'skills')); } catch { return null; } };

function bundled(root) {
  try { return new Set(fs.readFileSync(path.join(root, '.bundled_manifest'), 'utf8').split('\n').map((l) => l.split(':')[0].trim()).filter(Boolean)); } catch { return new Set(); }
}

function frontmatter(text) {
  const block = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const field = (name) => block.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  return { name: field('name'), description: field('description') };
}

export function listSkills(agent) {
  const root = skillsRoot(agent);
  if (!root) return [];
  const builtin = bundled(root);
  const skills = [];
  const walk = (dir, depth) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const skillFile = path.join(full, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        const meta = frontmatter(fs.readFileSync(skillFile, 'utf8'));
        const rel = path.relative(root, full);
        const name = meta.name || entry.name;
        skills.push({ path: rel, name, category: rel.includes(path.sep) ? rel.split(path.sep)[0] : '', description: meta.description, builtin: builtin.has(name) || builtin.has(entry.name), modifiedAt: Math.floor(fs.statSync(skillFile).mtimeMs / 1000) });
      } else if (depth < 2) {
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  return skills.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

function skillDir(agent, rel) {
  const root = skillsRoot(agent);
  if (!root || typeof rel !== 'string' || !rel || rel.includes('\0')) throw new HttpError(400, 'Bad skill path.', 'bad_skill');
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep) || !fs.existsSync(path.join(full, 'SKILL.md'))) throw new HttpError(404, 'Skill not found.', 'no_skill');
  return { root, full };
}

export function readSkill(agent, rel) {
  const { full } = skillDir(agent, rel);
  return { path: rel, content: fs.readFileSync(path.join(full, 'SKILL.md'), 'utf8').slice(0, 60_000) };
}

// Only skills that were made locally (by an agent or by you) can be removed; they go to a trash folder, not nowhere.
export function trashSkill(agent, rel) {
  const { root, full } = skillDir(agent, rel);
  const name = frontmatter(fs.readFileSync(path.join(full, 'SKILL.md'), 'utf8')).name || path.basename(full);
  if (bundled(root).has(name) || bundled(root).has(path.basename(full))) throw new HttpError(409, 'Built-in skills cannot be removed here.', 'builtin_skill');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(config.hermesRoot, 'backups', 'skills-trash', stamp, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(full, target);
  return { trashedTo: target };
}
