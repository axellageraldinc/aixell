// Prompt templates for Fresh: plain Markdown files with {{slots}}.
//
//   src/fresh/prompts/<name>.md   the shipped English template
//   render(name, vars)            the text with every slot filled
//
// The slots are {{language}} (the content language, as a name), {{profile}} (who the reader is),
// {{categories}} (the category ids and their meaning), {{terms}} (glossary rules for one batch),
// {{titleMax}}, {{summaryMaxWords}}, {{whyMaxWords}} (the writer limits) and {{schema}} (the JSON
// keys the writer must answer with). An unknown slot is an error: a template that asks for
// something the caller does not pass would otherwise send "{{typo}}" to a model.
import fs from 'node:fs';
import path from 'node:path';

export const PROMPT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'prompts');

const cache = new Map();

export function template(name) {
  if (cache.has(name)) return cache.get(name);
  const file = path.join(PROMPT_DIR, `${name}.md`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(`prompt template "${name}" is missing`);
  }
  cache.set(name, text);
  return text;
}

// -> the template with {{name}} replaced. A slot with no value, or a value for a slot the
// template does not use, throws.
export function render(name, vars = {}) {
  const text = template(name);
  const wanted = new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]));
  for (const key of Object.keys(vars)) {
    if (!wanted.has(key)) throw new Error(`prompt template "${name}" has no slot {{${key}}}`);
  }
  for (const key of wanted) {
    if (vars[key] === undefined || vars[key] === null) throw new Error(`prompt template "${name}" needs a value for {{${key}}}`);
  }
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key]));
}

// Tests and a template edit: forget what was read.
export const resetPromptCache = () => cache.clear();
