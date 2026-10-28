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
import { voiceSupported } from './voice-support.js';

const PICK = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
const MIN_RECORD_MS = 700;
const MAX_RECORD_MS = 90_000;
// Silence between two chunks of one reply (seconds), on top of the model's own tail.
const CHUNK_GAP = 0.2;

let active = null;

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
  let work = null; // AbortController of the upload and transcription
  let timer = 0;
  let raf = 0;
  let lastTop = null;

  function paint() {
    orb.dataset.state = mode;
    orb.replaceChildren(icon(ORB_ICON[mode], 30));
    orb.setAttribute('aria-label', HINT[mode]());
    hint.textContent = mode === 'recording' && rec ? `${HINT.recording()} · ${clock(Date.now() - rec.startedAt)}` : HINT[mode]();
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

  function stopRecording() {
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

  // ---- the reply
  function ask(text) {
    if (liveRun(state.agent, state.sessionId)) { setMode('idle'); say(t('voice.busy')); return; }
    you.textContent = text;
    reply.replaceChildren();
    turn = { ctx: null, chunker: createChunker(), gotText: false, ended: false, queue: [], pumping: false, scheduled: [], playing: 0, playEnd: 0, abort: new AbortController(), textOnly: false };
    setMode('thinking');
    const started = sendMessage({ text, attachments: [] });
    turn.ctx = liveRun(state.agent, state.sessionId); // created synchronously by sendMessage
    started.then((ok) => { if (ok === false && turn && !turn.gotText) { setMode('idle'); say(t('voice.busy')); turn = null; } });
  }

  function feed(texts) {
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
    const startAt = Math.max(audio.currentTime + 0.06, mine.playEnd + (mine.scheduled.length ? CHUNK_GAP : 0));
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
    clearInterval(timer);
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
  paint();
  document.body.append(overlay);
  orb.focus();
}
