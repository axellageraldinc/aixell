import { HttpError } from './http.js';
import { providersFor } from './providers/compat.js';

// Text to speech on the agent's speech provider (an OpenAI style /audio/speech endpoint). The voice chat asks for one
// sentence at a time, so the limit is small; a longer text is the caller's mistake, not something to cut silently.
export const MAX_SPEECH_CHARS = 1000;
const TIMEOUT_MS = 120_000;

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

// `speed` is optional: without it the speech provider speaks at its own pace.
export async function synthesizeSpeech(agent, text, { speed } = {}) {
  const spoken = String(text ?? '').trim();
  if (!spoken) throw new HttpError(400, 'There is nothing to say.', 'tts_empty');
  if (spoken.length > MAX_SPEECH_CHARS) throw new HttpError(413, `Speech is limited to ${MAX_SPEECH_CHARS} characters at a time.`, 'tts_too_long');
  if (speed !== undefined && (typeof speed !== 'number' || !(speed >= MIN_SPEED && speed <= MAX_SPEED))) throw new HttpError(400, `Speed must be a number from ${MIN_SPEED} to ${MAX_SPEED}.`, 'tts_bad_speed');
  const registry = providersFor(agent);
  const speech = registry.get('speech');
  if (!speech) throw new HttpError(501, 'Speech output is not available for this agent.', 'no_speech_backend');
  const conf = registry.config('speech') ?? {};
  try {
    return await speech.synthesize({ text: spoken, model: conf.model, voice: conf.voice, speed, format: 'mp3', timeoutMs: TIMEOUT_MS });
  } catch (err) {
    if (err.kind === 'nokey') throw new HttpError(501, err.message, 'no_speech_backend');
    if (err.kind === 'timeout') throw new HttpError(504, 'Speech timed out.', 'tts_timeout');
    if (err.kind === 'empty') throw new HttpError(502, 'The speech provider returned no audio.', 'tts_empty_audio');
    if (err.status) throw new HttpError(502, `Speech failed (${err.status}).`, 'tts_failed');
    throw err;
  }
}
