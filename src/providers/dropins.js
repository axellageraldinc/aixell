import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CatalogBase, OpenAICompatible } from './openai-compatible.js';
import { ProviderError, noKey, retryAfterOf } from './errors.js';

// Drop-in provider types: a `.js` or `.mjs` file in `<dataDir>/providers/` that default-exports either
//   { type, create(id, providerConfig, helpers) -> ProviderInstance }
// or a function `(kit) => { type, create }`. The function form lets a drop-in outside the repository reuse the building blocks
// of this repository without importing them by path; `kit` is { OpenAICompatible, CatalogBase, ProviderError, noKey, retryAfterOf }.
// `helpers` is the same object the built-in types get: { secret(ref) -> () => string|null, transport() -> fn|null }.
// A drop-in that fails to load or is malformed is logged and skipped; it never stops the app. A drop-in cannot replace a
// built-in type.
export const KIT = Object.freeze({ OpenAICompatible, CatalogBase, ProviderError, noKey, retryAfterOf });

export async function loadProviderDropins(dir, { builtin = [], warn = (m) => console.warn(`[providers] ${m}`) } = {}) {
  const types = {};
  let files = [];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /\.m?js$/.test(e.name) && !e.name.startsWith('.')).map((e) => e.name).sort();
  } catch (err) {
    if (err?.code !== 'ENOENT') warn(`cannot read the provider directory: ${err.message}`);
    return types;
  }
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, file)).href);
      const def = typeof mod.default === 'function' ? mod.default(KIT) : mod.default;
      if (!def || typeof def.type !== 'string' || !def.type || typeof def.create !== 'function') { warn(`drop-in "${file}" skipped: it must export { type, create }`); continue; }
      if (builtin.includes(def.type) || def.type in types) { warn(`drop-in "${file}" skipped: type "${def.type}" is already defined`); continue; }
      types[def.type] = def.create;
    } catch (err) {
      warn(`drop-in "${file}" skipped: ${err.message}`);
    }
  }
  return types;
}
