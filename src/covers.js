import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError } from './http.js';
import { providersFor } from './providers/compat.js';
import { runFfmpeg } from './ffmpeg.js';

// Cover pictures for the Feed home: one per chat, drawn from the chat's first message by the image models of the `images`
// capability (a free model family, newest first). Made on demand while the home feed is browsed, one at a time, and kept on disk, so each chat is drawn once.
const DIR = path.join(config.dataDir, 'covers');
// The first model of the chain is always tried first. Each model has its own per-minute limit: one that answers "too many" rests
// for a minute (or what it asks for) and the next model takes over meanwhile.
const RATE_REST_MS = 60_000;
const resting = new Map(); // model -> time until which it is left alone
// One picture takes 11-18 s whatever its size, but three at once finish in about the time of one and a half (measured).
const PARALLEL = 3;
const SAFE_ID = /^[\w.-]{1,100}$/;
const RETRY_AFTER_MS = 10 * 60_000;
const DAILY_LIMIT = 150;
const EDGE = 720;

const failed = new Map(); // key -> time of the last failure
const running = new Map(); // key -> promise (one drawing per chat at a time)
let active = 0;
const waiting = [];
const slot = () => (active < PARALLEL ? (active += 1, Promise.resolve()) : new Promise((resolve) => waiting.push(resolve)));
const release = () => { const next = waiting.shift(); if (next) next(); else active -= 1; };
let day = { date: '', count: 0 };

const keyOf = (agent, id) => `${agent.name}_${id}`;
const fileOf = (agent, id) => path.join(DIR, `${keyOf(agent, id)}.jpg`);

function checkId(id) {
  if (!SAFE_ID.test(String(id ?? ''))) throw new HttpError(400, 'Invalid chat id.', 'bad_session');
}

export function listCovers(agent) {
  try {
    const prefix = `${agent.name}_`;
    return fs.readdirSync(DIR).filter((f) => f.startsWith(prefix) && f.endsWith('.jpg')).map((f) => f.slice(prefix.length, -4));
  } catch {
    return [];
  }
}

export function coverFile(agent, id) {
  checkId(id);
  const file = fileOf(agent, id);
  return fs.existsSync(file) ? file : null;
}

export function removeCover(agent, id) {
  try { checkId(id); fs.rmSync(fileOf(agent, id), { force: true }); fs.rmSync(thumbOf(agent, id), { force: true }); } catch { /* nothing to remove */ }
}

// The story circles are 72 px wide: they get a small copy (made the first time it is asked for, kept in covers/t) instead of
// the 720 px picture of the post.
const THUMB_EDGE = 176;
const thumbOf = (agent, id) => path.join(DIR, 't', `${keyOf(agent, id)}.jpg`);
export async function thumbFile(agent, id) {
  const source = coverFile(agent, id);
  if (!source) return null;
  const thumb = thumbOf(agent, id);
  if (fs.existsSync(thumb)) return thumb;
  try {
    const small = await runFfmpeg(['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale=${THUMB_EDGE}:${THUMB_EDGE}:force_original_aspect_ratio=increase,crop=${THUMB_EDGE}:${THUMB_EDGE}`, '-q:v', '5', '-f', 'mjpeg', 'pipe:1'], fs.readFileSync(source));
    if (!small?.length) return source;
    fs.mkdirSync(path.dirname(thumb), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${thumb}.tmp`, small, { mode: 0o600 });
    fs.renameSync(`${thumb}.tmp`, thumb);
    return thumb;
  } catch {
    return source;
  }
}

// What the first message says, without attachment markers and markdown noise.
export function promptFrom(content) {
  return String(content ?? '')
    .split('\n')
    .filter((line) => !/^\[Attachment:/.test(line))
    .join(' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

// Every cover gets its own art style: they are handed out in turn (the list is ordered so neighbours look nothing alike)
// and the turn counter is kept on disk, so the feed never shows the same look twice in a row.
const STYLES = [
  'bold flat vector illustration, geometric shapes, limited bright palette',
  'soft watercolor painting, bleeding washes, visible paper texture',
  'pixel art, 16-bit video game scene',
  'paper cut-out collage, layered coloured paper with soft shadows',
  'Japanese ukiyo-e woodblock print, flat colour areas and fine outlines',
  'isometric 3D diorama, clean pastel render',
  'pop-art comic style, halftone dots and thick black outlines',
  'oil painting, thick visible brush strokes, impressionist light',
  'blueprint technical drawing, white lines on deep blue paper',
  'clay stop-motion 3D render, soft studio light',
  'minimal single-line drawing on a solid coloured background',
  'stained-glass window, vivid translucent colours, black lead lines',
  'risograph print, two spot colours with grain and slight misregistration',
  'low-poly 3D render, faceted shapes and gradients of light',
  'charcoal and chalk sketch on toned grey paper',
  'retro 1960s travel poster, screen-print texture, limited colours',
  'vintage botanical engraving, ink hatching with muted hand colouring',
  'embroidered textile, visible stitches on linen',
  'cyanotype photogram, white silhouettes on prussian blue',
  'gouache children\'s book illustration, playful and warm',
];
const STATE_FILE = path.join(DIR, 'styles.json');
function nextStyle() {
  let n = 0;
  try { n = Number(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).next) || 0; } catch { /* first cover */ }
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ next: n + 1 }), { mode: 0o600 });
  } catch { /* the style just repeats sooner */ }
  return STYLES[n % STYLES.length];
}

// An image model draws whatever it knows best (people) when it is given an abstract topic. So a small chat model first turns
// the topic into one concrete scene that stands for it; the picture is drawn from that scene, in the style.
async function visualScene(registry, topic) {
  const text = registry.get('writer');
  const model = registry.config('images')?.sceneModel;
  if (!text || !model) return null;
  try {
    const reply = await text.chat({
      model, maxTokens: 90, temperature: 0.8, reasoningEffort: 'none', timeoutMs: 20_000,
      messages: [
        { role: 'system', content: 'You turn a chat topic into the idea of ONE cover picture. Reply with a single English sentence (max 30 words) describing a concrete scene that clearly stands for what the chat is about, so that someone seeing only the picture would guess the topic (for example a calendar and a small house for days off, a microchip next to a stopwatch for a benchmark, a plug and a computer for wake-on-LAN, a cat and a dog squaring off for a pets picture request). Match the topic whatever it is: show people only if the topic is about a person or people, otherwise use objects, places, animals or symbols. Never include text, letters, words or numbers in the scene. Reply with the sentence only.' },
        { role: 'user', content: topic },
      ],
    });
    const scene = String(reply.text ?? '').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
    return scene.length >= 8 && scene.length <= 300 ? scene : null;
  } catch {
    return null;
  }
}

const imagePrompt = (scene, style) => `Square cover picture in this style: ${style}. Scene: ${scene}. The picture must clearly show this scene. Absolutely no text, no letters, no numbers, no words, no labels, no logos, no watermark.`;

const isRateLimit = (status, message = '') => status === 429 || /rate|limit|quota|too many/i.test(message);

async function draw(registry, topic, style) {
  const images = registry.get('images');
  const models = (registry.config('images')?.chain ?? []).map((entry) => entry.model);
  const scene = (await visualScene(registry, topic)) ?? topic;
  const prompt = imagePrompt(scene, style);
  let lastError = null;
  let rested = 0;
  for (const model of models) {
    if ((resting.get(model) ?? 0) > Date.now()) { rested += 1; continue; }
    try {
      const { bytes } = await images.generate({ prompt, model, size: '1024x1024', timeoutMs: 100_000 });
      if (bytes && bytes.length > 2000) return bytes;
      throw new Error('The image model returned no picture.');
    } catch (err) {
      if (err.status) { // the service answered with an error
        err.limited = isRateLimit(err.status, err.detail);
        err.restMs = (err.retryAfter || 0) * 1000 || RATE_REST_MS;
      }
      lastError = err;
      if (err.limited) resting.set(model, Date.now() + (err.restMs ?? RATE_REST_MS)); // on to the next model
    }
  }
  // Every model is resting or failed: a limit passes within a minute, so the chat is tried again soon.
  const error = lastError ?? new Error('Every image model is resting.');
  if (rested === models.length || lastError?.limited) error.limited = true;
  throw error;
}

// Draws the cover of one chat unless it exists. Resolves true when a file is there afterwards.
export function makeCover(agent, id, content) {
  checkId(id);
  const registry = providersFor(agent);
  if (!registry.get('images')) return Promise.resolve(false); // no image provider: no covers
  const key = keyOf(agent, id);
  if (fs.existsSync(fileOf(agent, id))) return Promise.resolve(true);
  if (running.has(key)) return running.get(key);
  if (Date.now() - (failed.get(key) ?? 0) < RETRY_AFTER_MS) return Promise.resolve(false);
  const topic = promptFrom(content);
  if (topic.length < 3) return Promise.resolve(false);
  const today = new Date().toISOString().slice(0, 10);
  if (day.date !== today) day = { date: today, count: 0 };
  if (day.count >= DAILY_LIMIT) throw new HttpError(429, 'The daily cover image limit is reached.', 'cover_limit');

  const style = nextStyle();
  const job = slot().then(async () => {
    try {
      day.count += 1;
      const png = await draw(registry, topic, style);
      const small = await runFfmpeg(['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale='min(${EDGE},iw)':-2`, '-q:v', '4', '-f', 'mjpeg', 'pipe:1'], png);
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
      const target = fileOf(agent, id);
      fs.writeFileSync(`${target}.tmp`, small ?? png, { mode: 0o600 });
      fs.renameSync(`${target}.tmp`, target);
      failed.delete(key);
      return true;
    } catch (err) {
      // A limit clears within a minute, so such a chat is tried again after 20 s; anything else waits the usual 10 minutes.
      failed.set(key, err.limited ? Date.now() - RETRY_AFTER_MS + 20_000 : Date.now());
      console.warn(`[hermes-web] cover for ${key} failed: ${err.message}`);
      return false;
    } finally {
      running.delete(key);
      release();
    }
  });
  running.set(key, job);
  return job;
}
