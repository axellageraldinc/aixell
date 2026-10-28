// The composer's voice-chat button: shown only when the browser can record and play sound and the server has a speech
// provider. The overlay itself loads on the first tap.
import { $ } from './dom.js';
import { api } from './api.js';
import { notify } from './ui.js';
import { t } from './i18n.js';
import { voiceSupported } from './voice-support.js';

export async function initVoiceEntry() {
  const button = $('#voice-button');
  if (!button || !voiceSupported()) return;
  try {
    const caps = await api('/api/capabilities');
    if (!caps.speech) return;
  } catch { return; }
  button.hidden = false;
  button.addEventListener('click', () => {
    import('./voice.js').then((m) => m.openVoice(), () => notify(t('voice.loadFailed')));
  });
}
