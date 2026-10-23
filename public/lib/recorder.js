// The composer's mic. Two modes behind one button:
//  - dictation (touch devices with the Web Speech API, i.e. Chrome on Android): speech is turned into text live and
//    typed into the message box, like the keyboard's mic key;
//  - recording (everything else, or when dictation is unavailable): click to start, click again to stop and attach
//    the recording, which is transcribed by the server.
import { $ } from './dom.js';
import { notify } from './ui.js';
import { fmtClock } from './format.js';
import { api, agentPath } from './api.js';
import { state } from './state.js';
import { t } from './i18n.js';

const button = $('#mic-button');
const timeEl = $('#mic-time');

const PICK = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
const MAX_MS = 10 * 60_000;
// Dictation stops by itself after this long without hearing anything (longer before the first word).
const IDLE_AFTER_SPEECH_MS = 2500;
const IDLE_BEFORE_SPEECH_MS = 8000;

const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
const touchPrimary = window.matchMedia('(pointer: coarse)');
const LANGS = { en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-PT', ja: 'ja-JP', zh: 'zh-CN' };

// Which mic mode this browser uses (Settings → Mic): 'auto' = dictation on touch screens, recording elsewhere.
const MODE_KEY = 'hermes-web:mic-mode';
export const speechSupported = Boolean(Speech);
export function getMicMode() {
  try { const mode = localStorage.getItem(MODE_KEY); return mode === 'dictation' || mode === 'record' ? mode : 'auto'; } catch { return 'auto'; }
}
export function setMicMode(mode) {
  try { if (mode === 'auto') localStorage.removeItem(MODE_KEY); else localStorage.setItem(MODE_KEY, mode); } catch { /* per-page only */ }
  modeChanged();
}
let modeChanged = () => {};

// The Settings "voice language" decides the recognition language; "auto" follows the browser.
async function speechLang() {
  try {
    const { sttLanguage } = await api(`${agentPath(state.agent)}/settings`);
    return LANGS[sttLanguage] ?? (navigator.language || 'en-US');
  } catch { return navigator.language || 'en-US'; }
}

// Android Chrome sometimes reports each growing phrase as its own result ("hello", "hello there", "hello there friend").
// A result that starts with the previous one replaces it, so the text is not repeated.
function transcriptOf(results) {
  const parts = [];
  for (let i = 0; i < results.length; i += 1) {
    const text = results[i][0].transcript.trim();
    if (!text) continue;
    const last = parts[parts.length - 1];
    if (last && text.toLowerCase().startsWith(last.toLowerCase())) parts[parts.length - 1] = text;
    else parts.push(text);
  }
  return parts.join(' ');
}

// The recogniser sometimes says a phrase again (every restarted session, or each growing guess becomes a result of its
// own): a run of 4+ words that is immediately followed by itself, or by a longer version of itself, is kept once.
export const collapseRepeats = (text) => text.replace(/(\S+(?:\s+\S+){3,})\s+(?=\1(?![\p{L}\p{N}]))/giu, '').replace(/(\S+(?:\s+\S+){3,})\s+(?=\1)/giu, '');

export function initRecorder({ onRecorded, isBlocked }) {
  const canRecord = Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
  if (!canRecord && !Speech) { button.hidden = true; return; }
  const input = $('#composer-input');
  let dictationBroken = false;
  let dictating = null;
  modeChanged = () => { dictationBroken = false; };
  const dictation = () => {
    if (!Speech || dictationBroken) return false;
    const mode = getMicMode();
    return mode === 'dictation' || (mode === 'auto' && touchPrimary.matches) || (!canRecord && mode !== 'record');
  };
  let recorder = null;
  let stream = null;
  let startedAt = 0;
  let timer = 0;
  let cancelled = false;

  const reset = () => {
    clearInterval(timer);
    stream?.getTracks().forEach((track) => track.stop());
    recorder = null;
    stream = null;
    button.classList.remove('is-recording');
    button.setAttribute('aria-label', t('composer.mic.record'));
    button.title = t('composer.mic.record');
    timeEl.hidden = true;
  };

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return notify(t('composer.mic.denied'));
    }
    const mimeType = PICK.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
    const chunks = [];
    cancelled = false;
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
    recorder.addEventListener('stop', () => {
      const type = (recorder?.mimeType || mimeType || 'audio/webm').split(';')[0];
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      reset();
      if (cancelled || !chunks.length) return;
      const stamp = new Date().toLocaleTimeString('en-GB').replaceAll(':', '-');
      onRecorded(new File(chunks, `voice-${stamp}.${ext}`, { type }));
    });
    recorder.start();
    startedAt = Date.now();
    button.classList.add('is-recording');
    button.setAttribute('aria-label', t('composer.mic.stop'));
    button.title = t('composer.mic.stopHint');
    timeEl.hidden = false;
    const tick = () => {
      const elapsed = Date.now() - startedAt;
      timeEl.textContent = fmtClock(elapsed / 1000);
      if (elapsed >= MAX_MS) recorder?.stop();
    };
    tick();
    timer = setInterval(tick, 250);
  }

  function paintListening(on) {
    button.classList.toggle('is-recording', on);
    button.setAttribute('aria-label', on ? t('composer.dictation.stop') : t('composer.mic.record'));
    button.title = on ? t('composer.dictation.stopHint') : t('composer.mic.record');
    timeEl.hidden = !on;
  }

  async function startDictation() {
    const lang = await speechLang();
    const startedAt = Date.now();
    const session = { stopping: false, cancelled: false, ended: false, rec: null, failure: null, timer: 0, original: input.value };
    dictating = session;
    let base = input.value;
    const write = (said) => {
      const joined = said ? `${base && !/\s$/.test(base) ? `${base} ` : base}${said}` : base;
      input.value = collapseRepeats(joined);
      input.dispatchEvent(new Event('input'));
    };
    const finish = () => {
      if (session.ended) return;
      session.ended = true;
      clearInterval(session.timer);
      dictating = null;
      paintListening(false);
      if (session.cancelled) { input.value = session.original; input.dispatchEvent(new Event('input')); }
      if (session.failure === 'not-allowed' || session.failure === 'service-not-allowed' || session.failure === 'language-not-supported') {
        notify(canRecord ? t('composer.speech.notAllowed') : t('composer.speech.denied'));
        dictationBroken = true;
      } else if (session.failure === 'network') notify(t('composer.speech.offline'));
      else if (session.failure === 'audio-capture') notify(t('composer.speech.noMic'));
    };
    // Chrome ends a session after a pause; the next one continues in the same box (what is typed so far becomes the base).
    let silent = 0;
    const run = () => {
      const rec = new Speech();
      session.rec = rec;
      rec.lang = lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      let heard = false;
      rec.onresult = (event) => {
        if (session.ended) return;
        heard = true;
        session.heardAny = true;
        session.lastHeardAt = Date.now();
        write(transcriptOf(event.results));
      };
      rec.onerror = (event) => { if (event.error !== 'no-speech' && event.error !== 'aborted') session.failure = event.error; };
      rec.onend = () => {
        if (session.stopping || session.failure || Date.now() - startedAt >= MAX_MS) return finish();
        silent = heard ? 0 : silent + 1;
        if (silent >= 2) return finish();
        base = input.value;
        try { run(); } catch { finish(); }
      };
      rec.start();
    };
    paintListening(true);
    session.lastHeardAt = startedAt;
    const tick = () => {
      timeEl.textContent = fmtClock((Date.now() - startedAt) / 1000);
      const quietMs = Date.now() - session.lastHeardAt;
      if (!session.stopping && quietMs > (session.heardAny ? IDLE_AFTER_SPEECH_MS : IDLE_BEFORE_SPEECH_MS)) { session.stopping = true; session.rec?.stop(); setTimeout(finish, 1500); }
    };
    tick();
    session.timer = setInterval(tick, 250);
    try { run(); } catch { finish(); }
  }

  button.addEventListener('click', () => {
    if (dictating) { dictating.stopping = true; dictating.rec?.stop(); return; }
    if (recorder) return recorder.stop();
    if (isBlocked()) return;
    if (dictation()) startDictation();
    else if (canRecord) start();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (dictating) { dictating.cancelled = true; dictating.stopping = true; dictating.rec?.abort(); }
    else if (recorder) { cancelled = true; recorder.stop(); }
  });
  // Ends a dictation immediately and keeps the text (used when the message is sent).
  function endDictation() {
    if (!dictating) return;
    const session = dictating;
    session.stopping = true;
    try { session.rec?.abort(); } catch { /* already ended */ }
    session.finishNow?.();
  }
  return { isRecording: () => Boolean(recorder || dictating), endDictation };
}
