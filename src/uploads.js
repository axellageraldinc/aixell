import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError } from './http.js';
import { runFfmpeg } from './ffmpeg.js';

const INDEX_DIR = path.join(config.dataDir, 'uploads');
const ID_PATTERN = /^[a-f0-9]{24}$/;
// The agent's own API caps a request body at 10 MB, and an inline image costs 4/3 of its bytes as base64, so the
// base64 budget below keeps a chat turn with several photos under that cap. A bigger photo is downscaled first
// (8.1 MP phone shots are 7-12 MB and used to come back as a 413 from the agent).
const INLINE_IMAGE_BUDGET = 5 * 1024 * 1024;
const INLINE_IMAGE_MAX_BASE64 = 1_500_000;
const DOWNSCALE_STEPS = [[2560, 2], [2048, 2], [2048, 3], [1600, 3], [1600, 4], [1280, 4], [1280, 6], [1024, 6], [800, 8]];
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.jsonl', '.yml', '.yaml', '.xml', '.html', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.kt', '.go', '.rs', '.c', '.h', '.cpp', '.sql', '.sh', '.log', '.ini', '.toml', '.properties', '.gradle']);
const IMAGE_TYPES = {
  'image/png': (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.oga', '.opus', '.webm', '.aac', '.flac', '.amr', '.3gp']);

const safeName = (name) => {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\- ]/g, '_').replace(/^\.+/, '').slice(0, 100);
  return base || 'file';
};

export function storeUpload(agent, { filename, mime, buffer }) {
  if (!buffer.length) throw new HttpError(400, 'The file is empty.', 'empty_file');
  const declared = String(mime || '').split(';')[0].trim().toLowerCase();
  // Images are trusted only when the magic bytes agree with the declared type.
  const isImage = Boolean(IMAGE_TYPES[declared]?.(buffer));
  const name = safeName(filename);
  const isAudio = !isImage && (declared.startsWith('audio/') || (declared === '' || declared === 'application/octet-stream') && AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase()));
  const id = crypto.randomBytes(12).toString('hex');
  // Same cache the Telegram adapter uses, so the agent reads it exactly like a Telegram attachment.
  const dir = path.join(agent.home, 'cache', 'documents');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(INDEX_DIR, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `webup_${id}_${name}`);
  fs.writeFileSync(filePath, buffer, { mode: 0o600 });
  const meta = { id, name, size: buffer.length, mime: isImage ? declared : (declared || 'application/octet-stream'), kind: isImage ? 'image' : isAudio ? 'audio' : 'file', agent: agent.name, path: filePath, createdAt: Date.now() };
  fs.writeFileSync(path.join(INDEX_DIR, `${id}.json`), JSON.stringify(meta), { mode: 0o600 });
  return { id, name, size: meta.size, mime: meta.mime, kind: meta.kind };
}

export function saveTranscript(id, text) {
  const file = path.join(INDEX_DIR, `${id}.json`);
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...meta, transcript: text }), { mode: 0o600 });
}

export function findUpload(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new HttpError(404, 'File not found.', 'upload_not_found');
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, `${id}.json`), 'utf8'));
    if (!fs.existsSync(meta.path)) throw new Error('gone');
    return meta;
  } catch {
    throw new HttpError(404, 'File not found.', 'upload_not_found');
  }
}

// Shrinks an image until its base64 fits the budget: a phone photo at full size is 8-12 MB, which base64 inflates
// past the agent's 10 MB request cap. ffmpeg re-encodes to JPEG at a smaller long edge; the original file stays on
// disk untouched (the agent can still open it by path).
async function fitImage(bytes, budget) {
  if (Math.ceil(bytes.length / 3) * 4 <= budget) return bytes;
  let smallest = null;
  for (const [edge, q] of DOWNSCALE_STEPS) {
    const out = await runFfmpeg([
      '-v', 'error', '-i', 'pipe:0', '-frames:v', '1',
      '-vf', `scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease`,
      '-q:v', String(q), '-f', 'mjpeg', 'pipe:1',
    ], bytes);
    if (!out) continue;
    if (Math.ceil(out.length / 3) * 4 <= budget) return out;
    if (!smallest || out.length < smallest.length) smallest = out;
  }
  return smallest;
}

// Turns upload ids into: extra text for the message + inline image parts (all validated, owned by this agent).
export async function buildAttachments(agent, ids) {
  const lines = [];
  const imageParts = [];
  const transcripts = [];
  let budget = INLINE_IMAGE_BUDGET;
  for (const id of ids) {
    const meta = findUpload(id);
    if (meta.agent !== agent.name) throw new HttpError(400, 'This attachment does not belong to this agent.', 'upload_wrong_agent');
    if (meta.kind === 'audio') {
      if (meta.transcript == null) throw new HttpError(400, `${meta.name} has not been transcribed yet.`, 'audio_not_transcribed');
      // No file path for the agent: it would try to transcribe the file itself with tools. The marker keeps the upload
      // id (the web shows it as a chip); the transcript below is the whole content.
      transcripts.push(meta.transcript);
      lines.push(`[Attachment: ${meta.name} (audio, ${meta.mime}) saved as webup_${meta.id}_${meta.name}]`);
      lines.push(`[Voice message or audio from the user, already transcribed automatically (the transcript is final and needs no re-check: do not run STT/whisper yourself and do not open the audio file; if the transcript looks odd or too short, say so to the user and ask): ${meta.name}]\n${meta.transcript}`);
      continue;
    }
    lines.push(`[Attachment: ${meta.name} (${meta.kind}, ${meta.mime}) saved at ${meta.path}]`);
    const bytes = fs.readFileSync(meta.path);
    if (meta.kind === 'image' && budget > 0) {
      const fitted = await fitImage(bytes, Math.min(INLINE_IMAGE_MAX_BASE64, budget));
      if (fitted?.length) {
        const mime = fitted.length === bytes.length ? meta.mime : 'image/jpeg';
        const base64 = fitted.toString('base64');
        budget -= base64.length;
        imageParts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } });
        if (fitted.length !== bytes.length) lines.push(`[Image ${meta.name} was sent to you in a downsized version (${Math.round(fitted.length / 1024)} KB of ${Math.round(bytes.length / 1024)} KB); the original file is at ${meta.path} if you need the full detail.]`);
      }
    } else if (meta.kind === 'file' && bytes.length <= config.textInlineMaxBytes
      && (meta.mime.startsWith('text/') || TEXT_EXTENSIONS.has(path.extname(meta.name).toLowerCase()))) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        lines.push(`[Contents of ${meta.name}]:\n${text}`);
      } catch { /* binary: the agent still has the path */ }
    }
  }
  return { text: lines.join('\n\n'), imageParts, transcripts };
}
