// Runs `node --check` on every .js file under src/, scripts/, public/ (not public/vendor) and server.js.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collect(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = [path.join(ROOT, 'server.js')];
for (const dir of ['src', 'scripts', 'public']) collect(path.join(ROOT, dir), files);

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`syntax error in ${path.relative(ROOT, file)}\n${result.stderr}`);
  }
}
console.log(`checked ${files.length} files, ${failed} with errors`);
process.exit(failed ? 1 : 0);
