import { getSttLanguage, STT_LANGUAGE_NAMES } from './agent-settings.js';
import { spawn } from 'node:child_process';
import { HttpError } from './http.js';
import { readEnvValue } from './agents.js';
import { findUpload, saveTranscript } from './uploads.js';
import { providersFor } from './providers/compat.js';
import { ffmpegPath } from './ffmpeg.js';

// Speech to text on the agent's own provider. A transcription provider (a Whisper style endpoint) is used when one is configured; OpenCode Go has no STT, so
// there an audio-capable chat model is given the recording as an input_audio part. Either way the recording is shrunk
// with ffmpeg first and the transcript goes to the agent as plain text, because the Hermes chat API only accepts
// text and image parts.
const MODEL = 'mimo-v2.6-flash';
// Per-agent voice language (Settings): the hint steers Whisper; 'auto' sends none and lets it guess.
const whisperHint = (code) => (STT_LANGUAGE_NAMES[code] ? `The speech is in ${STT_LANGUAGE_NAMES[code]}.` : '');
const MAX_SECONDS = 600;
const TIMEOUT_MS = 120_000;
const PROMPT = 'Transcribe the speech in this audio verbatim, in the language spoken. Reply with the transcript only, no commentary. If there is no speech, reply exactly: [no speech]';

// Any audio container in, small mono mp3 out.
function toMp3(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-v', 'error', '-i', filePath, '-t', String(MAX_SECONDS), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-f', 'mp3', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', () => reject(new HttpError(500, 'ffmpeg is not available on the server.', 'no_ffmpeg')));
    child.on('close', (code) => {
      const buffer = Buffer.concat(out);
      if (code !== 0 || !buffer.length) return reject(new HttpError(400, 'This file could not be read as audio.', 'bad_audio'));
      resolve(buffer);
    });
  });
}

export async function transcribeUpload(agent, id) {
  const meta = findUpload(id);
  if (meta.agent !== agent.name) throw new HttpError(400, 'This attachment does not belong to this agent.', 'upload_wrong_agent');
  if (meta.kind !== 'audio') throw new HttpError(400, 'This file is not audio.', 'not_audio');
  if (meta.transcript != null) return meta.transcript;
  const mp3 = await toMp3(meta.path);
  const transcription = providersFor(agent).get('transcription');
  if (transcription) {
    const text = await runTranscription(agent, transcription, mp3);
    saveTranscript(id, text);
    return text;
  }
  const key = readEnvValue(agent, 'OPENCODE_GO_API_KEY');
  if (!key || !agent.baseUrl) throw new HttpError(501, 'Audio input is not available for this agent.', 'no_audio_backend');
  let res;
  try {
    res = await fetch(`${agent.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'x-opencode-session': `web-stt-${id}` },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'input_audio', input_audio: { data: mp3.toString('base64'), format: 'mp3' } }] }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(504, 'Transcription timed out.', 'stt_timeout');
  }
  if (!res.ok) throw new HttpError(502, `Transcription failed (${res.status}).`, 'stt_failed');
  const message = (await res.json())?.choices?.[0]?.message;
  // This model sometimes puts its whole answer in the reasoning field and leaves content empty.
  const text = String(message?.content || message?.reasoning_content || '').trim();
  if (!text) throw new HttpError(502, 'The model returned no transcript.', 'stt_empty');
  saveTranscript(id, text);
  return text;
}

export async function runTranscription(agent, transcription, mp3) {
  const registry = providersFor(agent);
  // Without a hint Whisper guesses the language from a few seconds of audio and a short greeting can come back in the wrong language.
  const hint = whisperHint(getSttLanguage(agent.name));
  try {
    return (await transcription.transcribe({ audio: mp3, mime: 'audio/mpeg', hint, model: registry.config('transcription')?.model, timeoutMs: TIMEOUT_MS })).text;
  } catch (err) {
    if (err.kind === 'nokey') throw new HttpError(501, err.message, 'no_audio_backend');
    if (err.kind === 'timeout') throw new HttpError(504, 'Transcription timed out.', 'stt_timeout');
    if (err.kind === 'empty') throw new HttpError(502, 'No speech was recognised.', 'stt_empty');
    if (err.status) throw new HttpError(502, `Transcription failed (${err.status}).`, 'stt_failed');
    throw err;
  }
}
