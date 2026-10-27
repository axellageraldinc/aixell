// DOM builders for finished messages (history and streamed): user block, assistant text, meta line.
import { h } from './dom.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { copyWithFeedback } from './clipboard.js';
import { fmtDateTime, fmtDuration, fmtBytes } from './format.js';
import { openLightbox } from './lightbox.js';
import { t } from './i18n.js';

// The backend writes attachments into the user text as "[Attachment: name (kind, mime) saved at /path/webup_<id>_name]"
// (older sessions: "[Attachment: name (kind)]"). They are shown as thumbnails / chips instead of text.
const ATTACHMENT_LINE = /^\[Attachment: (.+?) \((\w+)(?:, ([^)]*))?\)(?: saved (?:at|as) (.+))?\]$/;
const UPLOAD_ID = /webup_([a-f0-9]{24})_/;

// Everything after the first attachment marker is marker lines plus inlined file text: only the markers are kept.
export function parseUserContent(content) {
  const lines = String(content ?? '').split('\n');
  const first = lines.findIndex((line) => ATTACHMENT_LINE.test(line));
  if (first === -1) return { text: String(content ?? '').trim(), files: [] };
  const files = [];
  for (const line of lines.slice(first)) {
    const match = line.match(ATTACHMENT_LINE);
    if (match) files.push({ name: match[1], kind: match[2], mime: match[3] ?? null, id: match[4]?.match(UPLOAD_ID)?.[1] ?? null });
  }
  return { text: lines.slice(0, first).join('\n').trim(), files };
}

const uploadUrl = (id) => `/api/uploads/${encodeURIComponent(id)}`;

const typeOf = (file) => {
  const ext = file.name.includes('.') ? file.name.split('.').pop() : '';
  return file.kind === 'audio' ? 'AUDIO' : (ext || 'FILE').slice(0, 5).toUpperCase();
};

// A file the user sent: a small card with its name and type (same look as in the composer); it downloads when tapped.
function fileCard(file) {
  const inner = [h('span', { className: 'att-name', title: file.name }, file.name), h('span', { className: 'att-foot' }, h('span', { className: 'att-type' }, typeOf(file)))];
  return file.id
    ? h('a', { className: 'att att-file att-sent', href: uploadUrl(file.id), download: file.name, title: t('attachments.download', { name: file.name }), 'data-testid': 'file-card' }, inner)
    : h('span', { className: 'att att-file att-sent', title: file.name }, inner);
}

function imageThumb(file) {
  const src = uploadUrl(file.id);
  const img = h('img', { src, alt: file.name, loading: 'lazy', className: 'att-img' });
  const button = h('button', { type: 'button', className: 'att att-image att-sent thumb', 'aria-label': t('attachments.view', { name: file.name }), 'data-testid': 'image-thumb' }, img);
  button.addEventListener('click', () => openLightbox(src, file.name));
  // The cached copy can be cleaned up by the agent: fall back to a plain card.
  img.addEventListener('error', () => button.replaceWith(fileCard({ ...file, id: null })));
  return button;
}

// files: optional [{ id, name, kind }] when the caller already knows them (a message that was just sent).
export function userNode(content, timestamp, files = null) {
  const parsed = files ? { text: String(content ?? '').trim(), files } : parseUserContent(content);
  const images = parsed.files.filter((f) => f.kind === 'image' && f.id);
  const others = parsed.files.filter((f) => !(f.kind === 'image' && f.id));
  const atts = [...images.map(imageThumb), ...others.map(fileCard)];
  return h(
    'div',
    { className: 'msg msg-user', 'data-testid': 'message-user' },
    atts.length ? h('div', { className: 'user-atts' }, atts) : null,
    parsed.text ? h('div', { className: 'user-body' }, renderMarkdown(parsed.text, { user: true })) : null,
    timestamp == null ? null : h('div', { className: 'meta' }, fmtDateTime(timestamp)),
  );
}

// Meta line with time, total time cost and a copy button. update() fills it once the reply is complete.
export function assistantMeta(getText) {
  const info = h('span', { 'data-testid': 'reply-meta' });
  const copy = h(
    'button',
    { type: 'button', className: 'ibtn ibtn-sm', 'aria-label': t('chat.message.copy'), title: t('chat.message.copy') },
    icon('copy', 14),
  );
  copy.addEventListener('click', () =>
    copyWithFeedback(getText(), (ok) => {
      copy.replaceChildren(icon(ok ? 'check' : 'copy', 14));
    }),
  );
  const el = h('div', { className: 'meta', hidden: true }, info, copy);
  return {
    el,
    update({ timestamp = null, duration = null } = {}) {
      info.textContent = [
        timestamp == null ? '' : fmtDateTime(timestamp),
        duration == null ? '' : t('chat.reply.duration', { duration: fmtDuration(duration) }),
      ].filter(Boolean).join(' · ');
      el.hidden = false;
    },
  };
}

export const systemNode = (content) => h('p', { className: 'msg-note' }, content ?? '');

export const fileSizeLabel = fmtBytes;

// activity: an Activity group node or null. Used for history; the live message builds the same parts incrementally.
export function assistantNode({ activity = null, answer = '', timestamp = null, duration = null }) {
  const meta = assistantMeta(() => answer);
  const parts = [activity, answer.trim() ? renderMarkdown(answer) : null];
  if (parts.some(Boolean) || duration != null) meta.update({ timestamp, duration });
  return h('article', { className: 'msg msg-assistant', 'data-testid': 'message-assistant' }, parts, meta.el);
}
