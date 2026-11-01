// "Share as story": one prompt and its reply drawn as a 1080x1920 picture (a chat on a flat card) and handed to the system
// Share sheet, where Instagram is on phones, or downloaded. A long exchange is first shortened by the server (src/story.js);
// the person can edit both texts before sharing.
import { api, agentPath } from './api.js';
import { state } from './state.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { notify } from './ui.js';
import { t } from './i18n.js';
import { APP_NAME } from './brand.js';
import { agentLabel } from './format.js';

const W = 1080;
const H = 1920;
const FONT = '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
// Instagram draws its own bar over the top and the reply box over the bottom: nothing important goes there.
const TOP = 270;
const BOTTOM = H - 270;
const SIDE = 80;
const COLORS = { bg: '#101216', user: '#2f6bff', userText: '#ffffff', bot: '#23272f', botText: '#eceff4', muted: '#8d95a3', name: '#b8c0cc' };

// Greedy word wrap; a word longer than the line is broken by letters.
export function wrap(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= maxWidth) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
      while (ctx.measureText(line).width > maxWidth && line.length > 1) {
        let n = line.length - 1;
        while (n > 1 && ctx.measureText(line.slice(0, n)).width > maxWidth) n -= 1;
        lines.push(line.slice(0, n));
        line = line.slice(n);
      }
    }
    lines.push(line);
  }
  return lines;
}

// The largest font (down to 30 px) at which both bubbles fit between the two safe lines.
function layout(ctx, prompt, reply) {
  const pad = 44;
  const maxBubble = W - SIDE * 2 - 60;
  const gap = 56;
  const label = 70;
  for (let size = 58; size >= 30; size -= 2) {
    const lead = Math.round(size * 1.4);
    ctx.font = `500 ${size}px ${FONT}`;
    const u = wrap(ctx, prompt, maxBubble - pad * 2);
    const a = wrap(ctx, reply, maxBubble - pad * 2);
    const uh = u.length * lead + pad * 2;
    const ah = a.length * lead + pad * 2;
    const total = uh + ah + gap + label * 2;
    if (total <= BOTTOM - TOP || size === 30) return { size, lead, pad, gap, label, u, a, uh, ah, total, maxBubble };
  }
  return null;
}

function bubble(ctx, { x, y, w, h: hh, fill, lines, color, size, lead, pad, right }) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, hh, [44, 44, right ? 12 : 44, right ? 44 : 12]);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.fillStyle = color;
  ctx.font = `500 ${size}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => ctx.fillText(line, x + pad, y + pad + size + i * lead - size * 0.12));
}

export function renderStory({ prompt, reply, assistant }) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx || !prompt?.trim() || !reply?.trim()) return Promise.reject(new Error('nothing to draw'));
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  const m = layout(ctx, prompt.trim(), reply.trim());
  const width = (lines) => Math.min(m.maxBubble, Math.max(...lines.map((l) => ctx.measureText(l).width)) + m.pad * 2);
  ctx.font = `500 ${m.size}px ${FONT}`;
  const uw = width(m.u);
  const aw = width(m.a);
  // The block is centred between the safe lines.
  let y = TOP + Math.max(0, (BOTTOM - TOP - m.total) / 2);

  ctx.font = `600 30px ${FONT}`;
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = 'right';
  ctx.fillText(t('story.you'), W - SIDE, y + 38);
  y += m.label;
  bubble(ctx, { x: W - SIDE - uw, y, w: uw, h: m.uh, fill: COLORS.user, lines: m.u, color: COLORS.userText, size: m.size, lead: m.lead, pad: m.pad, right: true });
  y += m.uh + m.gap;

  ctx.font = `600 30px ${FONT}`;
  ctx.fillStyle = COLORS.name;
  ctx.textAlign = 'left';
  ctx.fillText(assistant || APP_NAME, SIDE, y + 38);
  y += m.label;
  bubble(ctx, { x: SIDE, y, w: aw, h: m.ah, fill: COLORS.bot, lines: m.a, color: COLORS.botText, size: m.size, lead: m.lead, pad: m.pad, right: false });

  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.muted;
  ctx.font = `500 30px ${FONT}`;
  ctx.fillText(APP_NAME, W / 2, BOTTOM + 70);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve({ blob: b, canvas }) : reject(new Error('could not render the image'))), 'image/png'));
}

// Opens the share sheet where files are supported, else downloads the picture.
export async function shareImage(blob) {
  const file = new File([blob], `${APP_NAME}-story.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}

// The dialog: shortens the exchange, shows the picture, lets the person edit the two texts, then shares.
export async function openStoryDialog({ prompt, reply }) {
  const opener = document.activeElement;
  const shut = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); opener?.focus?.(); };
  const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); shut(); } };
  const close = h('button', { type: 'button', className: 'ibtn', 'aria-label': t('common.close'), onClick: shut }, icon('x', 18));
  const body = h('div', { className: 'dlg-body story-dlg' }, h('p', { className: 'dlg-note' }, t('story.shortening')));
  const panel = h('div', { className: 'modal-box dlg-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('story.title'), 'data-testid': 'story-dialog' },
    h('div', { className: 'dlg-head' }, h('h2', {}, t('story.title')), h('span', { className: 'dlg-spacer' }), close), body);
  const overlay = h('div', { className: 'dlg modal modal-open' }, panel);
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) shut(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);

  let text;
  try {
    text = await api(`${agentPath(state.agent)}/story`, { method: 'POST', body: { prompt, reply } });
  } catch (err) {
    body.replaceChildren(h('p', { className: 'dlg-note', role: 'alert' }, err.message));
    return;
  }
  const you = h('textarea', { className: 'textarea story-text', rows: 3, maxLength: 400, 'aria-label': t('story.you'), 'data-testid': 'story-prompt' }, text.prompt);
  const bot = h('textarea', { className: 'textarea story-text', rows: 6, maxLength: 800, 'aria-label': t('story.reply'), 'data-testid': 'story-reply' }, text.reply);
  const preview = h('div', { className: 'story-preview', 'data-testid': 'story-preview' });
  const message = h('p', { className: 'dlg-note', role: 'status' }, text.shortened ? t('story.shortened') : '');
  const go = h('button', { type: 'button', className: 'btn btn-primary btn-sm', 'data-testid': 'story-share' }, t('story.share'));
  let made = null;
  let timer = 0;
  const draw = async () => {
    try {
      made = await renderStory({ prompt: you.value, reply: bot.value, assistant: agentLabel(state.agent) });
      made.canvas.className = 'story-canvas';
      preview.replaceChildren(made.canvas);
      go.disabled = false;
    } catch { made = null; go.disabled = true; }
  };
  const redraw = () => { clearTimeout(timer); timer = setTimeout(draw, 200); };
  you.addEventListener('input', redraw);
  bot.addEventListener('input', redraw);
  go.addEventListener('click', async () => {
    if (!made) return;
    go.disabled = true;
    try {
      const result = await shareImage(made.blob);
      if (result === 'downloaded') notify(t('story.downloaded'));
      if (result !== 'cancelled') shut();
    } catch (err) { message.textContent = err.message; }
    go.disabled = false;
  });
  body.replaceChildren(
    preview,
    h('div', { className: 'share-field' }, h('span', { className: 'share-label' }, t('story.you')), you),
    h('div', { className: 'share-field' }, h('span', { className: 'share-label' }, t('story.reply')), bot),
    message,
    h('div', { className: 'dlg-row' }, go),
  );
  draw();
}
