import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Hermes ships its own ffmpeg under ~/.hermes/tools; fall back to PATH when it is not there.
export function ffmpegPath() {
  const tools = path.join(os.homedir(), '.hermes', 'tools');
  try {
    for (const dir of fs.readdirSync(tools)) {
      const candidate = path.join(tools, dir, 'bin', 'ffmpeg');
      if (dir.startsWith('ffmpeg') && fs.existsSync(candidate)) return candidate;
    }
  } catch { /* no bundled ffmpeg */ }
  return 'ffmpeg';
}

// Runs ffmpeg with the buffer on stdin and collects stdout. Resolves null when ffmpeg is missing or fails,
// so callers can fall back instead of throwing.
export function runFfmpeg(args, input) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && out.length ? Buffer.concat(out) : null));
    child.stdin.on('error', () => { /* ffmpeg exited before reading everything */ });
    child.stdin.end(input);
  });
}

// Same, but returns what ffmpeg printed on stderr (filters such as blurdetect report there); null when ffmpeg is missing.
export function logFfmpeg(args, input) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(err));
    child.stdin.on('error', () => { /* ffmpeg exited before reading everything */ });
    child.stdin.end(input);
  });
}
