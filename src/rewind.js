import { HttpError } from './http.js';
import { runHermesScript } from './hermes-python.js';

// "Edit last message" and "Regenerate" both start by taking the last user turn (and the reply to it) out of the
// session history. Hermes does that itself (/undo, /retry); src/rewind.py runs the same code.
export async function rewindLastTurn(agent, sessionId) {
  const result = await runHermesScript('rewind.py', [agent.home, sessionId]);
  if (result.error === 'nothing_to_rewind') throw new HttpError(409, 'There is no message to redo.', 'nothing_to_rewind');
  if (result.error === 'not_text') throw new HttpError(409, 'This message has attachments, so it cannot be redone automatically.', 'not_text');
  return result;
}
