// Live dictation for the voice chat: the browser's speech recognition turns speech into text as it is said, so there is no
// recording to upload and transcribe. It ends by itself after a pause, like the composer's dictation. (The composer's own
// dictation lives in recorder.js and types into the message box; this one hands the text back.)
import { collapseRepeats, transcriptOf } from './recorder.js';

const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
const IDLE_AFTER_SPEECH_MS = 2500;
const IDLE_BEFORE_SPEECH_MS = 8000;

// listen({ lang, onText(text), onEnd({ text, failure }), maxMs }) -> { startedAt, stop(), cancel() }
// onText gets the whole text so far on every result; onEnd is called once, with what was heard and the recogniser's error
// (null when it ended normally). stop() ends it and keeps the text; cancel() ends it silently.
export function listen({ lang, onText, onEnd, maxMs = 90_000 }) {
  const startedAt = Date.now();
  const session = { startedAt, stopping: false, ended: false, rec: null, failure: null, text: '', heardAny: false, lastHeardAt: startedAt };
  let base = '';
  let silentRuns = 0;
  let timer = 0;

  const finish = (quiet = false) => {
    if (session.ended) return;
    session.ended = true;
    clearInterval(timer);
    if (!quiet) onEnd({ text: session.text, failure: session.failure });
  };

  // Chrome ends a session after a pause; the next one carries on and what was heard so far becomes the base.
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
      const said = transcriptOf(event.results);
      session.text = collapseRepeats(said ? `${base && !/\s$/.test(base) ? `${base} ` : base}${said}` : base);
      onText(session.text);
    };
    rec.onerror = (event) => { if (event.error !== 'no-speech' && event.error !== 'aborted') session.failure = event.error; };
    rec.onend = () => {
      if (session.stopping || session.failure || Date.now() - startedAt >= maxMs) return finish();
      silentRuns = heard ? 0 : silentRuns + 1;
      if (silentRuns >= 2) return finish();
      base = session.text;
      try { run(); } catch { finish(); }
    };
    rec.start();
  };

  const stop = () => {
    if (session.stopping || session.ended) return;
    session.stopping = true;
    try { session.rec?.stop(); } catch { /* already ended */ }
    setTimeout(finish, 1500); // if the recogniser never says it ended
  };
  timer = setInterval(() => {
    const quiet = Date.now() - session.lastHeardAt;
    if (!session.stopping && quiet > (session.heardAny ? IDLE_AFTER_SPEECH_MS : IDLE_BEFORE_SPEECH_MS)) stop();
  }, 250);
  try { run(); } catch { finish(); }

  return {
    startedAt,
    stop,
    cancel() {
      session.stopping = true;
      try { session.rec?.abort(); } catch { /* already ended */ }
      finish(true);
    },
  };
}
