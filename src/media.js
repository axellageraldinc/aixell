import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError, SECURITY_HEADERS } from './http.js';

// Files an agent hands back as MEDIA:<path> in a reply (generated images, TTS, video, music). Only media types, and only
// from the agent's own home or the system temp dir, so a reply can never make the web serve configs, keys or databases.
const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.pdf': 'application/pdf',
};
const INLINE = /^(image|audio|video)\//;
const SECRET_PARTS = new Set(['.env', 'auth.json', 'vault', 'sessions', 'state', 'platforms']);

const inside = (root, file) => file === root || file.startsWith(root + path.sep);

export function resolveMedia(agent, raw) {
  const wanted = String(raw ?? '').trim();
  const notFound = new HttpError(404, 'File not found.', 'media_not_found');
  if (!wanted.startsWith('/') && !wanted.startsWith('~/')) throw notFound;
  const type = TYPES[path.extname(wanted).toLowerCase()];
  if (!type) throw notFound;
  let file;
  try { file = fs.realpathSync(wanted.startsWith('~/') ? path.join(os.homedir(), wanted.slice(2)) : wanted); } catch { throw notFound; }
  const roots = [agent.home, os.tmpdir()].map((root) => { try { return fs.realpathSync(root); } catch { return root; } });
  if (!roots.some((root) => inside(root, file))) throw notFound;
  if (path.relative(roots[0], file).split(path.sep).some((part) => SECRET_PARTS.has(part))) throw notFound;
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw notFound;
  return { file, type, size: stat.size, name: path.basename(file) };
}

// Supports Range, which Safari needs before it plays audio or video.
export function serveMedia(req, res, agent, raw) {
  const { file, type, size, name } = resolveMedia(agent, raw);
  const headers = {
    ...SECURITY_HEADERS, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': INLINE.test(type) ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }); return void res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return void fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}
