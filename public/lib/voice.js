// Voice chat: a full-screen overlay over the open chat. Tap the orb to speak and tap again to send; the recording is
// transcribed on the server and goes through the normal chat flow (so the turn is saved in the history like any other),
// and the reply is spoken sentence by sentence while it streams, with the words being said highlighted like karaoke
// lyrics. Speech comes from the agent's `speech` provider, one request per chunk of one to three sentences.
import { h } from './dom.js';
import { icon } from './icons.js';
import { api, agentPath, fetchRaw, toApiError } from './api.js';
import { state, on, liveRun } from './state.js';
import { sendMessage, stopRun } from './chat.js';
import { t } from './i18n.js';
import { createChunker, wordTimings, wordAt } from './voice-speech.js';
import { pickFiller, waitPlan, createFillerCache } from './voice-fillers.js';
import { voiceSupported } from './voice-support.js';
import { wantsDictation, speechLang } from './recorder.js';
import { listen } from './dictation.js';

const PICK = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
const MIN_RECORD_MS = 700;
const MAX_RECORD_MS = 90_000;
// Silence between two chunks of one reply (seconds), on top of the model's own tail.
const CHUNK_GAP = 0.2;

let active = null;

// The synthesized filler phrases, one cache per agent, kept while the page lives so a phrase is requested once.
const fillerCaches = new Map();
let fillerSpeed = 1; // how fast the fillers are spoken, from the server's sets
function fillerCache(agent) {
  if (!fillerCaches.has(agent)) {
    fillerCaches.set(agent, createFillerCache(async (text) => {
      const res = await fetchRaw(`${agentPath(agent)}/speech`, { method: 'POST', body: { text, speed: fillerSpeed } });
      if (!res.ok) throw await toApiError(res);
      return res.arrayBuffer();
    }));
  }
  return fillerCaches.get(agent);
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const clock = (ms) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const extOf = (mime) => (mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm');
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// One line of status text and one hint under the orb for each state. Literal t() calls so the key scan sees them.
const STATUS = {
  idle: () => '',
  recording: () => t('voice.status.listening'),
  transcribing: () => t('voice.status.transcribing'),
  thinking: () => t('voice.status.thinking'),
  speaking: () => t('voice.status.speaking'),
};
const HINT = {
  idle: () => t('voice.hint.idle'),
  recording: () => t('voice.hint.recording'),
  transcribing: () => t('voice.hint.working'),
  thinking: () => t('voice.hint.working'),
  speaking: () => t('voice.hint.speaking'),
};
const ORB_ICON = { idle: 'mic', recording: 'square', transcribing: 'square', thinking: 'square', speaking: 'square' };

export function openVoice() {
  if (active || !voiceSupported()) return;
  const opener = document.activeElement;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audio = new AudioCtx();
  audio.resume?.(); // inside the tap that opened the overlay, so the browser allows sound

  const close = h('button', { type: 'button', className: 'ibtn voice-close', 'aria-label': t('voice.close'), title: t('voice.close'), 'data-testid': 'voice-close' }, icon('x', 20));
  const you = h('p', { className: 'voice-you', 'data-testid': 'voice-you' });
  const reply = h('div', { className: 'voice-reply', 'data-testid': 'voice-reply' });
  const body = h('div', { className: 'voice-body' }, you, reply);
  const status = h('p', { className: 'voice-status', role: 'status', 'aria-live': 'polite', 'data-testid': 'voice-status' });
  const orb = h('button', { type: 'button', className: 'voice-orb', 'data-testid': 'voice-orb' });
  const hint = h('p', { className: 'voice-hint' });
  const fillerLine = h('p', { className: 'voice-filler', 'data-testid': 'voice-filler' });
  const overlay = h(
    'div',
    { className: 'voice', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('voice.label'), 'data-testid': 'voice-overlay' },
    h('div', { className: 'voice-top' }, h('span', { className: 'voice-title' }, t('voice.label')), close),
    body,
    h('div', { className: 'voice-foot' }, status, orb, hint),
  );

  let mode = 'idle';
  let note = ''; // an error or a notice shown instead of the state's own status line
  let turn = null; // the reply being spoken
  let rec = null; // the recording in progress
  let dict = null; // the dictation in progress (the Settings mic mode picks dictation or recording, as for the composer's mic)
  let dictationBroken = false; // a dictation failed in this overlay: record from now on
  let work = null; // AbortController of the upload and transcription
  let timer = 0;
  let raf = 0;
  let lastTop = null;
  let fillerSet = null; // the phrases to speak while the agent works, from the server
  let closed = false;
  let shownIcon = '';

  function paint() {
    orb.dataset.state = mode;
    // Redrawn only when it changes: replacing the icon under a finger that is pressing the orb would lose the tap.
    if (shownIcon !== ORB_ICON[mode]) {
      shownIcon = ORB_ICON[mode];
      orb.replaceChildren(icon(shownIcon, 30));
    }
    orb.setAttribute('aria-label', HINT[mode]());
    const live = rec ?? dict;
    hint.textContent = mode === 'recording' && live ? `${HINT.recording()} · ${clock(Date.now() - live.startedAt)}` : HINT[mode]();
    status.textContent = note || STATUS[mode]();
    status.classList.toggle('is-error', Boolean(note));
  }
  function setMode(next) {
    mode = next;
    paint();
  }
  function say(message) {
    note = message;
    paint();
  }

  // ---- recording and transcription
  async function startRecording() {
    if (liveRun(state.agent, state.sessionId)) { say(t('voice.busy')); return; }
    note = '';
    if (wantsDictation({ canRecord: true, broken: dictationBroken })) return startDictating();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      say(t('voice.micDenied'));
      return;
    }
    const mime = PICK.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const parts = [];
    const take = { recorder, stream, startedAt: Date.now(), cancelled: false };
    recorder.ondataavailable = (event) => { if (event.data.size) parts.push(event.data); };
    recorder.onstop = () => {
      clearInterval(timer);
      for (const track of stream.getTracks()) track.stop();
      if (rec === take) rec = null;
      if (take.cancelled) return;
      if (Date.now() - take.startedAt < MIN_RECORD_MS || !parts.length) { setMode('idle'); say(t('voice.tooShort')); return; }
      const type = recorder.mimeType || mime || 'audio/webm';
      transcribe(new File(parts, `voice.${extOf(type)}`, { type }));
    };
    rec = take;
    recorder.start();
    setMode('recording');
    timer = setInterval(() => {
      if (Date.now() - take.startedAt >= MAX_RECORD_MS) stopRecording();
      else paint();
    }, 250);
  }

  // Dictation: the words appear as they are said and go to the agent when it ends (a tap, or a pause), with no upload.
  async function startDictating() {
    // Shown as listening at once, so a second tap while the language loads stops it instead of starting another.
    let stopped = false;
    const pending = { startedAt: Date.now(), stop() { stopped = true; }, cancel() { stopped = true; } };
    dict = pending;
    you.textContent = '';
    setMode('recording');
    timer = setInterval(paint, 250);
    const lang = await speechLang();
    if (closed || stopped || dict !== pending) { clearInterval(timer); if (dict === pending) dict = null; if (!closed) setMode('idle'); return; }
    dict = listen({
      lang,
      maxMs: MAX_RECORD_MS,
      onText: (text) => { you.textContent = text; },
      onEnd: ({ text, failure }) => {
        clearInterval(timer);
        dict = null;
        if (failure && failure !== 'audio-capture') { dictationBroken = true; setMode('idle'); say(t('voice.dictationFailed')); return; }
        if (failure) { setMode('idle'); say(t('voice.micDenied')); return; }
        const said = text.trim();
        if (!said) { setMode('idle'); say(t('voice.noSpeech')); return; }
        ask(said);
      },
    });
  }

  function stopRecording() {
    if (dict) { dict.stop(); return; }
    if (rec?.recorder.state === 'recording') rec.recorder.stop();
  }

  async function transcribe(file) {
    setMode('transcribing');
    work = new AbortController();
    try {
      const up = await api(`${agentPath(state.agent)}/uploads`, { method: 'POST', body: file, headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': file.type }, signal: work.signal });
      const { text } = await api(`${agentPath(state.agent)}/uploads/${encodeURIComponent(up.id)}/transcribe`, { method: 'POST', signal: work.signal });
      const said = String(text ?? '').trim();
      if (!said || /^\[no speech\]$/i.test(said)) { setMode('idle'); say(t('voice.noSpeech')); return; }
      ask(said);
    } catch (err) {
      if (err.name === 'AbortError') return;
      setMode('idle');
      say(err.code === 'stt_empty' ? t('voice.noSpeech') : err.message);
    } finally {
      work = null;
    }
  }

  // ---- fillers: short phrases while the agent works
  async function loadFillers() {
    try {
      fillerSet = await api(`${agentPath(state.agent)}/voice-fillers`);
      fillerSpeed = Number(fillerSet.speed) || 1;
    } catch {
      return; // no fillers: the voice chat works the same without them
    }
    const cache = fillerCache(state.agent);
    for (const text of fillerSet.start) { // the first phrase has to be ready the moment a turn starts
      if (closed) return;
      await cache.get(text);
    }
  }

  // The first filler plays at once. Each later one comes after waiting `after` seconds from the end of the previous one (a
  // phrase that could not be played counts as ended now), following the plan in order; the last wait repeats.
  function startFillers(mine) {
    const set = fillerSet;
    if (!set) return;
    const cache = fillerCache(state.agent);
    const ready = set.start.filter((text) => cache.ready(text));
    mine.fill.last = pickFiller(ready.length ? ready : set.start, mine.fill.last);
    mine.fill.plan = waitPlan(set.waits);
    mine.fill.step = 0;
    mine.fill.timers.push(setTimeout(() => playFiller(mine, mine.fill.last, 1500), 0));
  }

  function nextFiller(mine) {
    const fill = mine.fill;
    if (turn !== mine || mine.gotText || !fill.plan?.length) return;
    const { after, phrases } = fill.plan[Math.min(fill.step, fill.plan.length - 1)];
    fill.step += 1;
    const text = pickFiller(phrases, fill.last);
    fill.last = text;
    fillerCache(state.agent).get(text); // asked for now: the wait is long enough for the audio to be ready
    fill.timers.push(setTimeout(() => playFiller(mine, text, 800), after * 1000));
  }

  // No new fillers (the answer has started or the turn is over). A phrase that is being said finishes, unless `source`.
  function stopFillers(mine, { source = false } = {}) {
    if (!mine) return;
    for (const timer of mine.fill.timers) clearTimeout(timer);
    mine.fill.timers = [];
    fillerLine.remove();
    if (source && mine.fill.source) {
      mine.fill.source.onended = null;
      try { mine.fill.source.stop(); } catch { /* not started */ }
      mine.fill.source = null;
    }
  }

  async function playFiller(mine, text, waitMs) {
    if (turn !== mine || mine.gotText) return;
    const bytes = text && audio.currentTime >= mine.fill.endsAt ? await Promise.race([fillerCache(state.agent).get(text), pause(waitMs).then(() => null)]) : null;
    let buffer = null;
    if (bytes && turn === mine && !mine.gotText) {
      try {
        buffer = await audio.decodeAudioData(bytes.slice(0));
      } catch { /* skipped */ }
    }
    if (turn !== mine || mine.gotText) return;
    if (!buffer || audio.currentTime < mine.fill.endsAt) { nextFiller(mine); return; }
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.destination);
    source.onended = () => { if (mine.fill.source === source) { mine.fill.source = null; nextFiller(mine); } };
    const startAt = audio.currentTime + 0.05;
    mine.fill.endsAt = startAt + buffer.duration;
    mine.fill.source = source;
    source.start(startAt);
    fillerLine.textContent = text;
    if (!fillerLine.isConnected) reply.prepend(fillerLine);
  }

  // ---- the reply
  function ask(text) {
    if (liveRun(state.agent, state.sessionId)) { setMode('idle'); say(t('voice.busy')); return; }
    you.textContent = text;
    reply.replaceChildren();
    turn = { ctx: null, chunker: createChunker(), gotText: false, ended: false, queue: [], pumping: false, scheduled: [], playing: 0, playEnd: 0, abort: new AbortController(), textOnly: false,
      fill: { timers: [], last: '', plan: null, step: 0, endsAt: 0, source: null } };
    setMode('thinking');
    const started = sendMessage({ text, attachments: [], spoken: true });
    turn.ctx = liveRun(state.agent, state.sessionId); // created synchronously by sendMessage
    startFillers(turn);
    started.then((ok) => { if (ok === false && turn && !turn.gotText) { stopFillers(turn); setMode('idle'); say(t('voice.busy')); turn = null; } });
  }

  function feed(texts) {
    if (texts.length) stopFillers(turn);
    for (const text of texts) {
      const words = text.split(/\s+/).filter(Boolean);
      const spans = words.map((word) => h('span', { className: 'w' }, word));
      const block = h('p', { className: 'voice-chunk' });
      spans.forEach((span, i) => { if (i) block.append(' '); block.append(span); });
      reply.append(block);
      turn.queue.push({ text, spans, timings: [], startAt: 0, shown: -2 });
    }
    if (texts.length) pump();
  }

  async function synthesize(text, signal) {
    const res = await fetchRaw(`${agentPath(state.agent)}/speech`, { method: 'POST', body: { text }, signal });
    if (!res.ok) throw await toApiError(res);
    return audio.decodeAudioData(await res.arrayBuffer());
  }

  async function pump() {
    const mine = turn;
    if (!mine || mine.pumping) return;
    mine.pumping = true;
    while (turn === mine && mine.queue.length) {
      const chunk = mine.queue.shift();
      try {
        schedule(mine, chunk, await synthesize(chunk.text, mine.abort.signal));
      } catch (err) {
        if (err.name === 'AbortError' || turn !== mine) return;
        mine.textOnly = true; // keep the text on screen, unhighlighted, and carry on with the next chunk
        say(t('voice.textOnly'));
        chunk.spans.forEach((span) => span.classList.add('said'));
      }
    }
    if (turn !== mine) return;
    mine.pumping = false;
    settle();
  }

  function schedule(mine, chunk, buffer) {
    if (turn !== mine) return;
    const startAt = Math.max(audio.currentTime + 0.06, mine.playEnd + (mine.scheduled.length ? CHUNK_GAP : 0), mine.fill.endsAt ? mine.fill.endsAt + 0.25 : 0);
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.destination);
    chunk.timings = wordTimings(chunk.text, buffer.duration);
    chunk.startAt = startAt;
    chunk.source = source;
    mine.playEnd = startAt + buffer.duration;
    mine.playing += 1;
    mine.scheduled.push(chunk);
    source.onended = () => { mine.playing -= 1; settle(); };
    source.start(startAt);
    if (mode !== 'speaking') setMode('speaking');
    if (!raf) raf = requestAnimationFrame(tick);
  }

  // The reply is over when its text has ended, every chunk has been spoken and nothing is waiting.
  function settle() {
    const mine = turn;
    if (!mine || !mine.ended || mine.pumping || mine.queue.length || mine.playing > 0) return;
    for (const chunk of mine.scheduled) paintWords(chunk, chunk.spans.length);
    stopFillers(mine);
    turn = null;
    if (mode !== 'idle') setMode('idle');
  }

  function paintWords(chunk, index) {
    if (index === chunk.shown) return;
    chunk.shown = index;
    chunk.spans.forEach((span, i) => {
      span.classList.toggle('said', i < index);
      span.classList.toggle('now', i === index);
    });
    const span = chunk.spans[index];
    if (!span) return;
    // Follow the voice: scroll only when the word moves to another line.
    if (span.offsetTop !== lastTop) {
      lastTop = span.offsetTop;
      span.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
    }
  }

  function tick() {
    raf = 0;
    const mine = turn;
    if (!mine) return;
    const now = audio.currentTime;
    for (const chunk of mine.scheduled) paintWords(chunk, wordAt(chunk.timings, now - chunk.startAt));
    if (mine.playing > 0 || mine.pumping || mine.queue.length) raf = requestAnimationFrame(tick);
  }

  // Silence now: audio, the queue and the pending requests. The text on screen stays.
  function hush() {
    const mine = turn;
    turn = null;
    if (!mine) return;
    mine.abort.abort();
    stopFillers(mine, { source: true });
    for (const chunk of mine.scheduled) {
      if (!chunk.source) continue;
      chunk.source.onended = null;
      try { chunk.source.stop(); } catch { /* not started yet */ }
    }
    cancelAnimationFrame(raf);
    raf = 0;
  }

  const offs = [
    on('reply:delta', ({ ctx, delta }) => {
      if (!turn || ctx !== turn.ctx) return;
      turn.gotText = true;
      feed(turn.chunker.push(delta));
    }),
    on('reply:completed', ({ ctx, content }) => {
      // A reply that did not stream arrives whole, once.
      if (!turn || ctx !== turn.ctx || turn.gotText || typeof content !== 'string') return;
      turn.gotText = true;
      feed(turn.chunker.push(content));
    }),
    on('reply:end', ({ ctx }) => {
      if (!turn || ctx !== turn.ctx) return;
      feed(turn.chunker.end());
      turn.ended = true;
      if (ctx.run.failed && !turn.gotText) { hush(); setMode('idle'); say(t('voice.replyFailed')); return; }
      settle();
    }),
  ];

  // ---- the orb, closing and keyboard
  orb.addEventListener('click', () => {
    if (mode === 'idle') startRecording();
    else if (mode === 'recording') stopRecording();
    else if (mode === 'transcribing') { work?.abort(); setMode('idle'); }
    else { // thinking or speaking: stop the voice and the reply
      hush();
      stopRun();
      setMode('idle');
    }
  });

  function shut() {
    document.removeEventListener('keydown', onKey, true);
    for (const off of offs) off();
    closed = true;
    clearInterval(timer);
    dict?.cancel();
    if (rec) { rec.cancelled = true; if (rec.recorder.state === 'recording') rec.recorder.stop(); }
    work?.abort();
    hush();
    audio.close?.().catch?.(() => {});
    overlay.remove();
    active = null;
    opener?.focus?.();
  }
  close.addEventListener('click', shut);

  function onKey(event) {
    if (event.key === 'Escape') { event.stopPropagation(); shut(); return; }
    if (event.key !== 'Tab') return;
    // Keep the focus inside the overlay: the close button comes first, the orb last.
    if (event.shiftKey && document.activeElement === close) { event.preventDefault(); orb.focus(); }
    else if (!event.shiftKey && document.activeElement === orb) { event.preventDefault(); close.focus(); }
  }
  document.addEventListener('keydown', onKey, true);

  active = { shut };
  loadFillers();
  paint();
  document.body.append(overlay);
  orb.focus();
}
