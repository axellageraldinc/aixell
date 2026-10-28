// Composer: auto-growing textarea, attachments (button, drag-and-drop, paste), Send/Stop button.
import { $, h } from './dom.js';
import { icon } from './icons.js';
import { state, boot, on, liveRun } from './state.js';
import { sendMessage, stopRun, steerRun } from './chat.js';
import { enqueue, remove as removeQueued, takeNext, queued, isPaused, bindQueue, initQueue } from './queue.js';
import { notify } from './ui.js';
import { createAttachments } from './attachments.js';
import { initModelChip } from './model-chip.js';
import { initRecorder } from './recorder.js';
import { initDrafts, clearDraft, restoreDraft, bindAttachments, syncPending } from './drafts.js';
import { focusQuietly } from './scroll.js';
import { initMarkdownEditor, initMarkdownPreview } from './md-editor.js';
import { initSlashMenu } from './templates.js';
import { allowSend } from './budget.js';
import { openMenu } from './menu.js';
import { t } from './i18n.js';

const phoneLike = () => window.matchMedia('(max-width: 899px), (pointer: coarse)').matches;
const MAX_INPUT_PX = 320; // about 13 lines of 24px
// With the on-screen keyboard open there is little room left: the box may take about a third of what is visible, then scrolls.
const maxInputPx = () => Math.max(72, Math.min(MAX_INPUT_PX, Math.round((window.visualViewport?.height ?? window.innerHeight) * 0.32)));
const form = $('#composer');
const input = $('#composer-input');

// Putting the cursor back in the box after a reply is for keyboards. On a phone it would pop the on-screen keyboard
// up every time a reply ends, so there only a tap on the box opens it.
const touchScreen = window.matchMedia('(pointer: coarse)');
const focusInput = () => { if (!touchScreen.matches && !input.disabled) focusQuietly(input); };
const action = $('#composer-action');
const stopBtn = $('#composer-stop');
const attachBtn = $('#attach-button');
const fileInput = $('#file-input');
const readonlyNotice = $('#read-only-notice');
const dropZone = $('#main');
const attachments = createAttachments({ container: $('#chips'), onChange: () => { update(); syncPending(); } });

// Why the composer cannot be used right now, or null.
function blockedReason() {
  if (!state.agent) return boot.pending ? null : t('composer.blocked.noAgent');
  if (state.agentOffline) return t('chat.offline.banner');
  return null;
}

const isReadOnly = () => state.session?.source === 'telegram';

// Sent before the account and agent list arrived: the box keeps the text, the button waits (see submit).
let waiting = false;

// The reply in flight of the chat that is open (other chats may have their own, running in the background).
const runningRun = () => liveRun(state.agent, state.sessionId);

function setAction(running, hasDraft) {
  // The send button never turns into Stop: while a reply runs it steers, and Stop gets its own button next to it. One
  // button that changes meaning was why a message could not be sent at all while the agent was working.
  action.dataset.mode = 'send';
  action.setAttribute('data-testid', 'send-button');
  action.setAttribute('aria-label', running ? t('composer.steer') : t('composer.send'));
  action.title = running ? t('composer.steer.hint') : t('composer.send');
  action.replaceChildren(waiting ? h('span', { className: 'loading loading-spinner loading-sm', 'aria-hidden': 'true' }) : icon('arrow-up'));
  action.toggleAttribute('aria-busy', waiting);
  action.hidden = false;
  return !hasDraft;
}

function update() {
  const readOnly = isReadOnly();
  form.hidden = readOnly;
  readonlyNotice.hidden = !readOnly;
  const blocked = blockedReason();
  const running = Boolean(runningRun());
  const recording = Boolean(mic?.isRecordingAudio());
  const hasDraft = input.value.trim() !== '' || attachments.count() > 0 || recording;
  input.disabled = Boolean(blocked);
  // Short on purpose: a long placeholder is cut off on a phone. The shortcuts live in the tooltip.
  input.placeholder = blocked ?? (running ? t('composer.placeholder.steer') : t('composer.input.placeholder'));
  input.title = running && !blocked ? t('composer.steer.enterHint') : '';
  attachBtn.disabled = Boolean(blocked) || boot.pending; // a file goes to the agent, which is not known yet
  const noDraft = setAction(running, hasDraft);
  if (recording && !running) { action.setAttribute('aria-label', t('composer.sendVoice')); action.title = t('composer.sendVoice'); }
  stopBtn.hidden = !running;
  action.disabled = Boolean(blocked) || waiting || attachments.isUploading() || attachments.hasFailed() || noDraft;
  if (blocked) action.title = blocked;
}

function resize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, maxInputPx())}px`;
}

// Sending ends a dictation at once; what was heard so far is already in the box and goes with the message.
let mic = null;

function takeDraft() {
  mic?.endDictation();
  const payload = { text: input.value.trim(), attachments: attachments.ready() };
  input.value = '';
  clearDraft();
  resize();
  attachments.clear();
  update();
  return payload;
}

// While a reply is running, a new message goes straight into it (steer). Text only: the agent reads it mid-turn, so a
// file has to wait for the next turn — that is the one case that still queues.
async function queueDraft() {
  if (!runningRun() || attachments.isUploading() || attachments.hasFailed()) return;
  if (input.value.trim() === '' && attachments.count() === 0) return;
  const hasFiles = attachments.count() > 0;
  const draft = takeDraft();
  if (!hasFiles && draft.text && await steerRun(draft.text)) return;
  enqueue(draft);
  if (!hasFiles) notify(t('composer.queued'));
}

// The queue sends itself, one message at a time, once the chat is idle (unless the last reply was stopped or failed).
let draining = false;
async function drain() {
  if (draining || runningRun() || blockedReason() || isReadOnly() || isPaused() || queued().length === 0) return;
  draining = true;
  const item = takeNext();
  try { await sendMessage(item); } finally { draining = false; update(); }
}

// Send while the mic is still recording: stop it and send now. The recording is uploaded and transcribed as the first
// step of the reply, so there is no wait before the message goes out.
async function submitVoice() {
  if (runningRun()) {
    // A reply is running: a recording cannot be steered in, so it ends up in the tray like a stopped one.
    const file = await mic.take();
    if (file) attachments.add([file]);
    return;
  }
  if (action.disabled) return;
  if (!(await allowSend())) return;
  const file = await mic.take();
  if (!file) return update();
  const payload = takeDraft();
  await sendMessage({ ...payload, voice: file });
  update();
  focusInput();
}

async function submit() {
  if (mic?.isRecordingAudio()) return submitVoice();
  if (runningRun()) return queueDraft();
  if (action.disabled) return;
  if (boot.pending) {
    // The text stays in the box and the button shows a spinner; the message goes out as soon as the agent is known.
    waiting = true;
    update();
    await boot.ready;
    waiting = false;
    update();
    if (action.disabled || runningRun()) return;
  }
  if (!(await allowSend())) return;
  const payload = takeDraft();
  await sendMessage(payload);
  update();
  focusInput();
}

function filesFrom(event) {
  return [...(event.dataTransfer?.files ?? [])];
}

function bindDropZone() {
  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('File');
  dropZone.addEventListener('dragover', (event) => {
    if (!hasFiles(event) || blockedReason() || isReadOnly()) return;
    event.preventDefault();
    dropZone.classList.add('is-dragover');
  });
  dropZone.addEventListener('dragleave', (event) => {
    if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('is-dragover');
  });
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('is-dragover');
    if (!blockedReason() && !isReadOnly()) attachments.add(filesFrom(event));
  });
}

export function initComposer() {
  initModelChip();
  mic = initRecorder({ onRecorded: (file) => attachments.add([file]), isBlocked: () => Boolean(blockedReason() || isReadOnly() || boot.pending), onChange: update });
  bindDropZone();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  action.addEventListener('click', () => submit());
  stopBtn.addEventListener('click', () => stopRun());
  initQueue();
  bindQueue({
    send: async (item) => {
      if (runningRun()) return;
      removeQueued(item.id);
      await sendMessage(item);
      update();
    },
  });
  on('run:concluded', ({ key } = {}) => { if (key === `${state.agent}:${state.sessionId ?? 'new'}`) drain(); });
  on('session:changed', () => setTimeout(drain, 80));
  const touchPrimary = window.matchMedia('(pointer: coarse)');
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') input.blur();
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    // On a phone / tablet (touch is the primary input) Enter is a new line and the Send button sends; Ctrl+Enter still works with a keyboard.
    if (touchPrimary.matches && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    submit();
  });
  input.addEventListener('input', () => {
    resize();
    update();
  });
  input.addEventListener('paste', (event) => {
    const images = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (images.length === 0) return;
    event.preventDefault();
    attachments.add(images);
  });
  const startTemplate = () => { input.value = '/'; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); };
  // Phone: a bottom sheet. Desktop: a small menu under/above the button with the same three entries.
  const pickFiles = (accept) => { fileInput.accept = accept; fileInput.click(); };
  attachBtn.addEventListener('click', () => {
    if (phoneLike()) return import('./attach-sheet.js').then(({ openAttachSheet }) => openAttachSheet({ onFiles: (files) => attachments.add(files), onTemplate: startTemplate }));
    openMenu(attachBtn, [
      { label: t('composer.attach.files'), icon: 'file', testid: 'attach-files', action: () => pickFiles('') },
      { label: t('composer.attach.photos'), icon: 'image', testid: 'attach-photos', action: () => pickFiles('image/*,video/*') },
      { separator: true },
      { label: t('composer.attach.template'), icon: 'zap', testid: 'attach-template', action: startTemplate },
    ], t('composer.attach.title'));
  });
  fileInput.addEventListener('change', () => {
    attachments.add([...fileInput.files]);
    fileInput.value = '';
    fileInput.accept = '';
  });

  on('agent:select', attachments.clear);
  window.visualViewport?.addEventListener('resize', resize);
  // The draft layer keeps the tray's files across a chat switch or a reload, and needs to read/rebuild it.
  bindAttachments(attachments);
  initDrafts({ input, after: () => { resize(); update(); } });
  initSlashMenu({ input, after: () => { resize(); update(); } });
  initMarkdownEditor({ input, enterNewlines: () => touchPrimary.matches });
  initMarkdownPreview({ input, button: $('#preview-toggle'), form })
  // A button inside a rendered visual block sends its text as the next message, the same path as a typed one.
  window.addEventListener('hermes:send-text', (event) => {
    const text = String(event.detail?.text ?? '').trim();
    if (!text || blockedReason() || isReadOnly() || runningRun() || boot.pending) return;
    sendMessage({ text, attachments: [] });
  });
  window.addEventListener('hermes:shared', (event) => {
    const { text, files } = event.detail ?? {};
    if (text) { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); }
    if (files?.length) attachments.add(files);
    focusInput();
  });
  // "New chat" shows the draft of the empty chat screen, not leftovers of the chat that was open: every keystroke
  // and every attached file was already saved under the key of the chat it belongs to (see drafts.js).
  on('chat:reset', () => restoreDraft({ force: true }));
  on('composer:focus', focusInput);
  for (const type of ['agent:status', 'session:changed', 'run:state', 'boot:ready']) on(type, update);
  update();
}
